package worker_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
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

// Installation failures are isolated: a failed listing enqueue or PR fetch
// cannot block another organisation's hourly evidence reconciliation.
func TestInstallationReconcileContinuesAfterFailure(t *testing.T) {
	for _, mode := range []string{"rate-limit", "provider-error", "enqueue-error"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			testutil.LinkRepo(t, f, 555, "acme", "widgets")
			var other uuid.UUID
			require.NoError(t, f.Pool.QueryRow(ctx, `INSERT INTO workspace(name,slug,issue_prefix) VALUES('Other','other','OTHER') RETURNING id`).Scan(&other))
			_, err := f.Pool.Exec(ctx, `INSERT INTO github_installation(id,account_login,workspace_id,ownership_verified_at,repos_synced_at) VALUES(100,'other',$1,now(),now())`, other)
			require.NoError(t, err)
			_, err = f.Store.LinkRepo(ctx, store.LinkRepoInput{WorkspaceID: other, InstallationID: 100, GitHubID: 556, Owner: "other", Name: "repo"})
			require.NoError(t, err)
			_, err = f.Pool.Exec(ctx, `UPDATE repo SET synced_at=now()-interval '3 hours' WHERE installation_id=99; UPDATE repo SET synced_at=now()-interval '2 hours' WHERE installation_id=100`)
			require.NoError(t, err)
			if mode == "enqueue-error" {
				_, err = f.Pool.Exec(ctx, `UPDATE github_installation SET repos_synced_at=NULL; CREATE FUNCTION reject_first_installation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.payload->>'installation_id')::bigint=99 THEN RAISE EXCEPTION 'queue unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_first BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION reject_first_installation()`)
				require.NoError(t, err)
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/app/installations/99/access_tokens", "/app/installations/100/access_tokens":
					json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
				case "/repos/acme/widgets/pulls":
					if mode == "rate-limit" {
						w.Header().Set("X-RateLimit-Remaining", "0")
						w.WriteHeader(403)
					} else {
						w.WriteHeader(500)
					}
					w.Write([]byte(`{"message":"private-provider-token"}`))
				case "/repos/other/repo/pulls":
					fmt.Fprintf(w, `[{"number":77,"title":"Recovered","state":"open","created_at":"2026-09-01T10:00:00Z","updated_at":%q}]`, time.Now().UTC().Format(time.RFC3339))
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()
			wk := testutil.NewWorker(t, f, srv)
			err = wk.Reconcile(ctx)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "private-provider-token")
			var title string
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT title FROM pull_request WHERE workspace_id=$1`, other).Scan(&title))
			require.Equal(t, "Recovered", title)
			var synced bool
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT synced_at>now()-interval '1 minute' FROM repo WHERE installation_id=100`).Scan(&synced))
			require.True(t, synced)
			if mode == "enqueue-error" {
				var id int
				require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (payload->>'installation_id')::int FROM job`).Scan(&id))
				require.Equal(t, 100, id)
			}
		})
	}
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

// Reconciliation alone must link a pull request, with no webhook ever
// delivered. This is what makes a localhost install usable: there is no public
// URL for GitHub to reach, so polling is the only path, and it has to be a
// complete one rather than a degraded fallback.
func TestReconcileAloneLinksWithoutAnyWebhook(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Wire up sign-in")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	w := testutil.NewWorker(t, f, stubWithPR(t, 77))
	require.NoError(t, w.Reconcile(t.Context()))

	var linked int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM pr_link WHERE issue_id = $1`, issue.ID).Scan(&linked))
	require.Equal(t, 1, linked, "polling alone must link the PR")

	var events int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM github_event`).Scan(&events))
	require.Equal(t, 0, events, "no webhook was delivered in this test")
}
