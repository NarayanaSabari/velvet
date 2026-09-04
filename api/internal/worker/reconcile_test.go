package worker_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// stubWithPR serves an installation token and one open PR on branch
// sabari/eng-1-fix-auth, which is the PR whose webhook never arrived.
func stubWithPR(t *testing.T, number int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
		case "/repos/acme/widgets/pulls":
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": number, "title": "Fix auth", "state": "open", "draft": false,
				"body": "", "html_url": "https://github.com/acme/widgets/pull/77",
				"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
				"user": map[string]any{"login": "sabari"},
				"head": map[string]any{"ref": "sabari/eng-1-fix-auth"},
			}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReconcileRecoversAMissedWebhook(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	w := testutil.NewWorker(t, f, stubWithPR(t, 77))
	require.NoError(t, w.Reconcile(t.Context()))

	var linked int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM pr_link WHERE issue_id = $1`, issue.ID).Scan(&linked))
	require.Equal(t, 1, linked,
		"reconciliation is what makes a missed webhook survivable")

	var syncedAt *time.Time
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT synced_at FROM repo WHERE github_id = 555`).Scan(&syncedAt))
	require.NotNil(t, syncedAt)
}

func TestReconcileIsIdempotent(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	wk := testutil.NewWorker(t, f, stubWithPR(t, 77))
	require.NoError(t, wk.Reconcile(t.Context()))
	require.NoError(t, wk.Reconcile(t.Context()))

	var prs, links, acts int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&prs))
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&links))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = 'attached_pr'`).Scan(&acts))
	require.Equal(t, 1, prs)
	require.Equal(t, 1, links)
	require.Equal(t, 1, acts)
}

func TestRateLimitLeavesSyncedAtUntouched(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset",
			strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	wk := testutil.NewWorker(t, f, srv)
	_ = wk.Reconcile(t.Context()) // the error is expected and not the assertion

	var syncedAt *time.Time
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT synced_at FROM repo WHERE github_id = 555`).Scan(&syncedAt))
	require.Nil(t, syncedAt,
		"stamping synced_at after a failed fetch would silently skip the gap")
}
