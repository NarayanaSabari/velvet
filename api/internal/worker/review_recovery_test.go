package worker_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestMissingReviewParentFetchFailureIsRetryable(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.LinkRepo(t, f, 555, "acme", "widgets")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"message":"private-provider-detail"}`)
	}))
	defer srv.Close()
	_, err := f.Store.RecordDelivery(t.Context(), "early-review", "pull_request_review", []byte(`{"installation":{"id":99},"repository":{"id":555},"pull_request":{"number":42},"review":{"id":123}}`))
	require.NoError(t, err)
	did, err := testutil.NewWorker(t, f, srv).ProcessOnce(t.Context())
	require.True(t, did)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "private-provider-detail")
	var processed, dead bool
	var attempts int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT processed_at IS NOT NULL FROM github_event WHERE delivery_id='early-review'`).Scan(&processed))
	require.False(t, processed)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT attempts, dead FROM job WHERE kind='process_delivery'`).Scan(&attempts, &dead))
	require.Equal(t, 1, attempts)
	require.False(t, dead)
}

func TestReviewRecovery(t *testing.T) {
	for _, mode := range []string{"review before PR", "missed review webhook", "review fetch failure"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			testutil.CreateIssue(t, f, "Fix auth")
			testutil.LinkRepo(t, f, 555, "acme", "widgets")
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				pr := fmt.Sprintf(`{"number":42,"title":"ENG-1 Fix auth","state":"open","updated_at":%q}`, time.Now().UTC().Format(time.RFC3339))
				switch r.URL.Path {
				case "/app/installations/99/access_tokens":
					json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
				case "/repos/acme/widgets/pulls":
					fmt.Fprintf(w, "[%s]", pr)
				case "/repos/acme/widgets/pulls/42":
					fmt.Fprint(w, pr)
				case "/repos/acme/widgets/pulls/42/reviews":
					if mode == "review fetch failure" {
						w.WriteHeader(http.StatusInternalServerError)
						fmt.Fprint(w, `{"message":"private-provider-detail"}`)
						return
					}
					fmt.Fprint(w, `[{"id":1234567890,"user":{"login":"reviewer"},"state":"approved","submitted_at":"2026-09-01T09:30:00Z"}]`)
				default:
					fmt.Fprint(w, `[]`)
				}
			}))
			defer srv.Close()
			wk := testutil.NewWorker(t, f, srv)
			if mode == "review before PR" {
				deliver(t, f, wk, "pull_request_review", "pull_request_review.submitted.json", "early-review")
				var count int
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_review`).Scan(&count))
				require.Equal(t, 1, count, "review delivery must recover its parent without waiting for reconciliation")
			}
			err := wk.Reconcile(t.Context())
			if mode == "review fetch failure" {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "private-provider-detail")
				var cutoff *time.Time
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT synced_at FROM repo WHERE github_id=555`).Scan(&cutoff))
				require.Nil(t, cutoff, "failed review fetch must leave the sync window retryable")
				return
			}
			require.NoError(t, err)
			_, err = f.Pool.Exec(t.Context(), `UPDATE repo SET synced_at=NULL`)
			require.NoError(t, err)
			require.NoError(t, wk.Reconcile(t.Context()))
			var count int
			var state string
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*), min(state) FROM pr_review`).Scan(&count, &state))
			require.Equal(t, 1, count, "recovery must not duplicate reviews")
			require.Equal(t, "approved", state)
		})
	}
}
