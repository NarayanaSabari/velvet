package worker_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
	"github.com/stretchr/testify/require"
)

const lifecycleSecret = "test-only-lifecycle-secret"

func signedDelivery(t *testing.T, f *testutil.Fixture, event, id, body string) {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(lifecycleSecret))
	mac.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", id)
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func signedFixture(t *testing.T, f *testutil.Fixture, event, id, fixture string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "testdata", "github", fixture))
	require.NoError(t, err)
	signedDelivery(t, f, event, id, string(body))
}

func drainLifecycle(t *testing.T, f *testutil.Fixture, wk *worker.Worker) {
	t.Helper()
	for n := 0; n < 30; n++ {
		did, err := wk.ProcessOnce(t.Context())
		require.NoError(t, err)
		if !did {
			return
		}
	}
	t.Fatal("queue did not drain")
}

func verifiedLifecycleRepo(t *testing.T, f *testutil.Fixture) store.Repo {
	t.Helper()
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	_, err := f.Pool.Exec(t.Context(), `UPDATE github_installation SET workspace_id=$1,ownership_verified_at=now(),repos_synced_at=now(),sync_generation=1 WHERE id=99`, f.WorkspaceID)
	require.NoError(t, err)
	return repo
}

// Disconnecting access must retain every historical identifier and all evidence.
func TestInstallationLifecycleWebhookPreservesEvidence(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
	ctx := t.Context()
	repo := verifiedLifecycleRepo(t, f)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	comment, err := f.Store.CreateComment(ctx, store.CreateCommentInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Body: "Keep discussion"})
	require.NoError(t, err)
	present, suspended := true, false
	prs := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99":
			var at any
			if suspended {
				at = "2026-09-08T10:00:00Z"
			}
			json.NewEncoder(w).Encode(map[string]any{"id": 99, "suspended_at": at})
		case "/app/installations/99/access_tokens", "/app/installations/100/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
		case "/installation/repositories":
			if present {
				fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":555,"name":"widgets","owner":{"login":"acme"}}]}`)
			} else {
				fmt.Fprint(w, `{"total_count":0,"repositories":[]}`)
			}
		case "/repos/acme/widgets/pulls":
			prs++
			fmt.Fprint(w, `[]`)
		default:
			t.Errorf("unexpected provider path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	wk := testutil.NewWorker(t, f, srv)
	signedFixture(t, f, "pull_request", "pr", "pull_request.opened.json")
	signedFixture(t, f, "pull_request_review", "review", "pull_request_review.submitted.json")
	signedFixture(t, f, "push", "push", "push.json")
	drainLifecycle(t, f, wk)
	before, err := f.Store.EvidenceForIssue(ctx, f.WorkspaceID, issue.ID)
	require.NoError(t, err)
	require.Len(t, before.PullRequests, 1)
	require.Len(t, before.Reviews, 1)
	require.Len(t, before.Commits, 2)
	assertEvidence := func() {
		after, err := f.Store.EvidenceForIssue(ctx, f.WorkspaceID, issue.ID)
		require.NoError(t, err)
		require.Equal(t, before, after)
		var body string
		require.NoError(t, f.Pool.QueryRow(ctx, `SELECT body FROM comment WHERE id=$1`, comment.ID).Scan(&body))
		require.Equal(t, "Keep discussion", body)
		got, err := f.Store.RepoByGitHubID(ctx, 555)
		require.NoError(t, err)
		require.Equal(t, repo.ID, got.ID)
	}
	lifecycle := func(action, id string) {
		event := "installation"
		if action == "removed" || action == "added" {
			event = "installation_repositories"
		}
		signedDelivery(t, f, event, id, fmt.Sprintf(`{"action":%q,"installation":{"id":99,"account":{"login":"acme"}},"repositories_removed":[],"repositories_added":[]}`, action))
		drainLifecycle(t, f, wk)
	}
	present = false
	lifecycle("removed", "remove")
	var disconnected bool
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NOT NULL FROM repo WHERE id=$1`, repo.ID).Scan(&disconnected))
	require.True(t, disconnected, "a complete empty provider listing must disconnect the absent repo")
	assertEvidence()
	for _, id := range []string{"remove", "redeliver"} {
		lifecycle("removed", id)
	}
	beforeCalls := prs
	require.NoError(t, wk.Reconcile(ctx))
	require.Equal(t, beforeCalls, prs, "inactive repository must not be reconciled")
	present = true
	lifecycle("added", "readd")
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NOT NULL FROM repo WHERE id=$1`, repo.ID).Scan(&disconnected))
	require.False(t, disconnected)
	assertEvidence()
	suspended = true
	lifecycle("suspend", "suspend")
	lifecycle("added", "late-added")
	lifecycle("unsuspend", "stale-unsuspend")
	status, err := f.Store.GitHubStatus(ctx, f.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, "suspended", status.Status)
	suspended = false
	lifecycle("unsuspend", "unsuspend")
	lifecycle("suspend", "delayed-suspend")
	status, err = f.Store.GitHubStatus(ctx, f.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, "connected", status.Status)
	lifecycle("deleted", "uninstall")
	lifecycle("created", "late-create")
	lifecycle("added", "late-add")
	var deleted, unbound bool
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,workspace_id IS NULL FROM github_installation WHERE id=99`).Scan(&deleted, &unbound))
	require.True(t, deleted)
	require.True(t, unbound)
	assertEvidence()
	// A reconnect uses a newly owner-authorized installation ID and adopts the
	// historical repo UUID through the same complete-list consumer.
	setup, err := f.Store.CreateGitHubSetup(ctx, f.Token, f.User.ID, f.WorkspaceID)
	require.NoError(t, err)
	state, _, err := f.Store.StartGitHubInstallationAuthorization(ctx, setup, f.Token, f.User.ID, 100)
	require.NoError(t, err)
	claim, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "installation")
	require.NoError(t, err)
	require.NoError(t, f.Store.BindInstallation(ctx, claim, github.VerifiedInstallation{ID: 100, AccountID: 42, AccountLogin: "acme", AccountType: "Organization"}))
	drainLifecycle(t, f, wk)
	assertEvidence()
}

// An exhausted authoritative state check must remain suspended, preserve its
// binding on 404, and recover through the owner's existing retry endpoint.
func TestInstallationSuspensionExhaustionCanRetry(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
	ctx := t.Context()
	verifiedLifecycleRepo(t, f)
	fail := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99":
			if fail {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"message":"private-provider-token"}`)
				return
			}
			fmt.Fprint(w, `{"id":99,"suspended_at":null}`)
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
		case "/installation/repositories":
			fmt.Fprint(w, `{"total_count":0,"repositories":[]}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	wk := testutil.NewWorker(t, f, srv)
	signedDelivery(t, f, "installation", "suspend", `{"action":"suspend","installation":{"id":99}}`)
	for i := 0; i < 5; i++ {
		_, err := f.Pool.Exec(ctx, `UPDATE job SET run_after=now() WHERE NOT dead`)
		require.NoError(t, err)
		_, err = wk.ProcessOnce(ctx)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "private-provider-token")
	}
	var retained bool
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT workspace_id=$1 AND deleted_at IS NULL AND suspended_at IS NOT NULL FROM github_installation WHERE id=99`, f.WorkspaceID).Scan(&retained))
	require.True(t, retained)
	status := f.Do("GET", "/api/v1/w/lab/github", nil)
	require.Contains(t, status.Body.String(), `"status":"suspended"`)
	t.Run("failure-visible", func(t *testing.T) { require.Contains(t, status.Body.String(), `"error":"sync_failed"`) })
	t.Run("manual-recovery", func(t *testing.T) {
		retry := f.Do("POST", "/api/v1/w/lab/github/sync", nil)
		require.Equal(t, 202, retry.Code, retry.Body.String())
		status = f.Do("GET", "/api/v1/w/lab/github", nil)
		require.Contains(t, status.Body.String(), `"status":"suspended"`)
		fail = false
		drainLifecycle(t, f, wk)
		status = f.Do("GET", "/api/v1/w/lab/github", nil)
		require.Contains(t, status.Body.String(), `"status":"connected"`)
	})
}

// A queued event's installation must not inherit access when the repo reconnects.
func TestInstallationQueuedWebhookFences(t *testing.T) {
	for _, mode := range []string{"reconnected", "disconnected", "suspended", "deleted", "unverified", "unbound"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
			ctx := t.Context()
			verifiedLifecycleRepo(t, f)
			testutil.CreateIssue(t, f, "Fix auth")
			testutil.InsertPullRequest(t, f, 42, "Historical PR", "open")
			_, err := f.Pool.Exec(ctx, `UPDATE pull_request SET gh_updated_at='2026-08-01T00:00:00Z'`)
			require.NoError(t, err)
			signedFixture(t, f, "pull_request", "pr", "pull_request.merged.json")
			signedFixture(t, f, "pull_request_review", "review", "pull_request_review.submitted.json")
			signedFixture(t, f, "push", "push", "push.json")
			query := map[string]string{
				"reconnected":  `INSERT INTO github_installation(id,account_login) VALUES(100,'acme'); UPDATE repo SET installation_id=100`,
				"disconnected": `UPDATE repo SET disconnected_at=now()`,
				"suspended":    `UPDATE github_installation SET suspended_at=now()`,
				"deleted":      `UPDATE github_installation SET deleted_at=now()`,
				"unverified":   `UPDATE github_installation SET ownership_verified_at=NULL`,
				"unbound":      `UPDATE github_installation SET workspace_id=NULL`,
			}[mode]
			_, err = f.Pool.Exec(ctx, query)
			require.NoError(t, err)
			wk := testutil.NewWorker(t, f, stubGitHub(t))
			drainLifecycle(t, f, wk)
			var title string
			var writes int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT title FROM pull_request WHERE number=42`).Scan(&title))
			require.Equal(t, "Historical PR", title)
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM pr_review)+(SELECT count(*) FROM commit_ref)+(SELECT count(*) FROM pr_link)`).Scan(&writes))
			require.Zero(t, writes)
		})
	}
}
