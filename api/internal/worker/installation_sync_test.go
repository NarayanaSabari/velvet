package worker_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// A PR's transaction must not borrow a second pool connection for issue
// lookup; otherwise concurrent workers can exhaust the pool while holding it.
func TestInstallationPRWriteUsesOneTransactionConnection(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
	verifiedLifecycleRepo(t, f)
	testutil.CreateIssue(t, f, "Fix auth")
	signedFixture(t, f, "pull_request", "pr", "pull_request.opened.json")
	cfg := f.Pool.Config()
	cfg.MaxConns = 1
	cfg.MinConns = 0
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	require.NoError(t, err)
	defer pool.Close()
	wk := worker.New(store.New(pool), nil)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	did, err := wk.ProcessOnce(ctx)
	require.True(t, did)
	require.NoError(t, err)
	var links int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&links))
	require.Equal(t, 1, links)
}

// A failure after page one must not apply its partial results or hide the last
// retry failure. The real admin retry route must recover the dead queue job.
func TestInstallationSyncPartialFailureExhaustionAndRetry(t *testing.T) {
	for _, mode := range []string{"rate-limit", "malformed", "partial", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
			ctx := t.Context()
			repo := verifiedLifecycleRepo(t, f)
			fail := true
			var srv *httptest.Server
			srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/app/installations/99/access_tokens":
					json.NewEncoder(w).Encode(map[string]any{"token": "private-provider-token", "expires_at": time.Now().Add(time.Hour)})
				case "/installation/repositories":
					if !fail {
						fmt.Fprint(w, `{"total_count":0,"repositories":[]}`)
						return
					}
					if r.URL.Query().Get("page") == "2" {
						switch mode {
						case "rate-limit":
							w.WriteHeader(429)
							fmt.Fprint(w, `{"message":"private-provider-token"}`)
						case "malformed":
							fmt.Fprint(w, `{"total_count":2,"repositories":"private-provider-token"}`)
						case "partial":
							fmt.Fprint(w, `{"total_count":2,"repositories":[]}`)
						case "timeout":
							w.WriteHeader(504)
							fmt.Fprint(w, `{"message":"private-provider-token"}`)
						}
						return
					}
					w.Header().Set("Link", fmt.Sprintf(`<%s/installation/repositories?page=2>; rel="next"`, srv.URL))
					fmt.Fprint(w, `{"total_count":2,"repositories":[{"id":556,"name":"partial","owner":{"login":"acme"}}]}`)
				case "/repos/acme/widgets/pulls":
					fmt.Fprint(w, `[]`)
				default:
					t.Errorf("unexpected provider path %s", r.URL.Path)
				}
			}))
			defer srv.Close()
			wk := testutil.NewWorker(t, f, srv)
			signedDelivery(t, f, "installation_repositories", "removed", `{"action":"removed","installation":{"id":99},"repositories_removed":[{"id":555}]}`)
			did, err := wk.ProcessOnce(ctx)
			require.True(t, did)
			require.NoError(t, err)
			for i := 0; i < 5; i++ {
				_, err := f.Pool.Exec(ctx, `UPDATE job SET run_after=now() WHERE NOT dead`)
				require.NoError(t, err)
				did, err = wk.ProcessOnce(ctx)
				require.True(t, did)
				require.Error(t, err)
				require.NotContains(t, err.Error(), "private-provider-token")
				var connected bool
				var count int
				require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NULL FROM repo WHERE id=$1`, repo.ID).Scan(&connected))
				require.True(t, connected)
				require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM repo`).Scan(&count))
				require.Equal(t, 1, count)
			}
			var attempts int
			var dead bool
			var reason string
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT attempts,dead,last_error FROM job`).Scan(&attempts, &dead, &reason))
			require.Equal(t, 5, attempts)
			require.True(t, dead)
			require.Equal(t, "sync_failed", reason)
			require.NoError(t, wk.Reconcile(ctx))
			status := f.Do("GET", "/api/v1/w/lab/github", nil)
			require.Equal(t, 200, status.Code)
			require.Contains(t, status.Body.String(), `"error":"sync_failed"`)
			var queued int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM job WHERE NOT dead`).Scan(&queued))
			require.Zero(t, queued)
			fail = false
			retry := f.Do("POST", "/api/v1/w/lab/github/sync", nil)
			require.Equal(t, 202, retry.Code, retry.Body.String())
			drainLifecycle(t, f, wk)
			status = f.Do("GET", "/api/v1/w/lab/github", nil)
			require.Contains(t, status.Body.String(), `"status":"connected"`)
			var disconnected bool
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NOT NULL FROM repo WHERE id=$1`, repo.ID).Scan(&disconnected))
			require.True(t, disconnected)
		})
	}
}

// The provider fetch must hold no application transaction. A newer webhook
// snapshot can finish while the first listing waits, and its result must win.
func TestInstallationSyncOverlappingWebhookSnapshots(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
	ctx := t.Context()
	repo := verifiedLifecycleRepo(t, f)
	started, release := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
		case "/installation/repositories":
			if requests.Add(1) == 1 {
				close(started)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				fmt.Fprint(w, `{"total_count":0,"repositories":[]}`)
				return
			}
			fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":555,"name":"current","owner":{"login":"acme"}}]}`)
		case "/repos/acme/current/pulls":
			fmt.Fprint(w, `[]`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	wk := testutil.NewWorker(t, f, srv)
	signedDelivery(t, f, "installation_repositories", "first", `{"action":"removed","installation":{"id":99}}`)
	_, err := wk.ProcessOnce(ctx)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { _, err := wk.ProcessOnce(ctx); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first provider list did not begin")
	}
	signedDelivery(t, f, "installation_repositories", "second", `{"action":"added","installation":{"id":99}}`)
	_, err = wk.ProcessOnce(ctx)
	require.NoError(t, err)
	_, err = wk.ProcessOnce(ctx)
	require.NoError(t, err)
	close(release)
	require.NoError(t, <-done)
	got, err := f.Store.RepoByGitHubID(ctx, 555)
	require.NoError(t, err)
	require.Equal(t, repo.ID, got.ID)
	require.Equal(t, "current", got.Name)
	var connected bool
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NULL FROM repo WHERE id=$1`, repo.ID).Scan(&connected))
	require.True(t, connected)
}

// A generation change after lookup but before write must drop each whole
// signed delivery, even though it was active when the worker resolved it.
func TestInstallationWebhookTransactionFence(t *testing.T) {
	for _, event := range []string{"pull_request", "pull_request_review", "push"} {
		t.Run(event, func(t *testing.T) {
			f := testutil.NewFixtureWithWebhookSecret(t, lifecycleSecret)
			ctx := t.Context()
			verifiedLifecycleRepo(t, f)
			testutil.CreateIssue(t, f, "Fix auth")
			testutil.InsertPullRequest(t, f, 42, "Historical PR", "open")
			_, err := f.Pool.Exec(ctx, `UPDATE pull_request SET gh_updated_at='2026-08-01T00:00:00Z'`)
			require.NoError(t, err)
			fixture := map[string]string{"pull_request": "pull_request.merged.json", "pull_request_review": "pull_request_review.submitted.json", "push": "push.json"}[event]
			signedFixture(t, f, event, "racing", fixture)
			tx, err := f.Pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, `SELECT id FROM workspace WHERE id=$1 FOR UPDATE`, f.WorkspaceID)
			require.NoError(t, err)
			wk := testutil.NewWorker(t, f, stubGitHub(t))
			done := make(chan error, 1)
			go func() { _, err := wk.ProcessOnce(ctx); done <- err }()
			require.Eventually(t, func() bool {
				var waiting bool
				err := f.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond)
			_, err = tx.Exec(ctx, `UPDATE github_installation SET sync_generation=sync_generation+1 WHERE id=99`)
			require.NoError(t, err)
			require.NoError(t, tx.Commit(ctx))
			require.NoError(t, <-done)
			var title string
			var writes int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT title FROM pull_request WHERE number=42`).Scan(&title))
			require.Equal(t, "Historical PR", title)
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM pr_link)+(SELECT count(*) FROM pr_review)+(SELECT count(*) FROM commit_ref)`).Scan(&writes))
			require.Zero(t, writes)
		})
	}
}

// A result fetched while active cannot write once a concurrent lifecycle event
// changes the generation, even when the result contains previously unseen PRs.
func TestInstallationReconcileFetchFence(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	verifiedLifecycleRepo(t, f)
	testutil.CreateIssue(t, f, "Fix auth")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{"token": "test-token", "expires_at": time.Now().Add(time.Hour)})
			return
		}
		_, err := f.Pool.Exec(context.Background(), `UPDATE github_installation SET sync_generation=sync_generation+1,suspended_at=now() WHERE id=99`)
		require.NoError(t, err)
		fmt.Fprint(w, `[{"number":77,"title":"ENG-1 late","state":"open","created_at":"2026-09-01T10:00:00Z","updated_at":"2026-09-01T10:00:00Z"}]`)
	}))
	defer srv.Close()
	wk := testutil.NewWorker(t, f, srv)
	require.NoError(t, wk.Reconcile(ctx))
	var writes int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM pull_request)+(SELECT count(*) FROM repo WHERE synced_at IS NOT NULL)`).Scan(&writes))
	require.Zero(t, writes)
}

func TestInstallationSyncWorkerConsumesAndSanitizes(t *testing.T) {
	for _, mode := range []string{"success", "provider-error", "no-client", "stale", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			_, err := f.Pool.Exec(ctx, `INSERT INTO github_installation(id,account_login,workspace_id,ownership_verified_at,sync_generation) VALUES(99,'acme',$1,now(),1)`, f.WorkspaceID)
			require.NoError(t, err)
			if mode == "conflict" {
				testutil.InsertForeignPullRequest(t, f, 9, "Foreign")
			}
			job := store.InstallationSync{InstallationID: 99, WorkspaceID: f.WorkspaceID, Generation: 1}
			if mode == "stale" {
				job.Generation = 0
			}
			require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error { return f.Store.EnqueueJob(ctx, tx, "sync_installation_repos", job) }))
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				switch r.URL.Path {
				case "/app/installations/99/access_tokens":
					json.NewEncoder(w).Encode(map[string]any{"token": "temporary-private-token", "expires_at": time.Now().Add(time.Hour)})
				case "/installation/repositories":
					if mode == "provider-error" {
						w.WriteHeader(500)
						fmt.Fprint(w, `{"message":"temporary-private-token"}`)
						return
					}
					fmt.Fprint(w, `{"total_count":2,"repositories":[{"id":555,"name":"widgets","owner":{"login":"acme"}},{"id":556,"name":"second","owner":{"login":"acme"}}]}`)
				default:
					fmt.Fprint(w, `[]`)
				}
			}))
			defer srv.Close()
			wk := testutil.NewWorker(t, f, srv)
			if mode == "no-client" {
				wk = worker.New(f.Store, nil)
			}
			did, err := wk.ProcessOnce(ctx)
			require.True(t, did)
			if mode == "success" {
				require.NoError(t, err)
				repos, err := f.Store.ListRepos(ctx, f.WorkspaceID)
				require.NoError(t, err)
				require.Len(t, repos, 2)
				require.NotNil(t, repos[0].SyncedAt)
				status, err := f.Store.GitHubStatus(ctx, f.WorkspaceID)
				require.NoError(t, err)
				require.Equal(t, "connected", status.Status)
			} else if mode == "stale" {
				require.NoError(t, err)
				require.Zero(t, calls)
			} else {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "temporary-private-token")
				var reason string
				require.NoError(t, f.Pool.QueryRow(ctx, `SELECT last_error FROM job`).Scan(&reason))
				require.NotContains(t, reason, "temporary-private-token")
				status, err := f.Store.GitHubStatus(ctx, f.WorkspaceID)
				require.NoError(t, err)
				require.Equal(t, "error", status.Status)
				expected := "sync_failed"
				if mode == "conflict" {
					expected = "repository_conflict"
				}
				require.Equal(t, expected, *status.Error)
				repos, err := f.Store.ListRepos(ctx, f.WorkspaceID)
				require.NoError(t, err)
				require.Empty(t, repos)
			}
		})
	}
}

func TestInstallationSyncLegacyWebhookAndSchedulerGate(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	_, err := f.Pool.Exec(ctx, `INSERT INTO github_installation(id,account_login,workspace_id) VALUES(99,'acme',$1)`, f.WorkspaceID)
	require.NoError(t, err)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("unverified binding reached provider")
		w.WriteHeader(500)
	}))
	defer srv.Close()
	wk := testutil.NewWorker(t, f, srv)
	_, err = f.Pool.Exec(ctx, `INSERT INTO github_event(delivery_id,event_type,payload) VALUES('legacy','installation_repositories','{"action":"added","installation":{"id":99,"account":{"login":"acme"}},"repositories_added":[{"id":555,"name":"hidden"}]}')`)
	require.NoError(t, err)
	require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error {
		return f.Store.EnqueueJob(ctx, tx, "process_delivery", map[string]string{"delivery_id": "legacy"})
	}))
	_, err = wk.ProcessOnce(ctx)
	require.NoError(t, err)
	require.NoError(t, wk.Reconcile(ctx))
	var n int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM repo)+(SELECT count(*) FROM job)`).Scan(&n))
	require.Zero(t, n)
}

func TestInstallationSyncVerifiedEventAndSchedulerEnqueue(t *testing.T) {
	for _, source := range []string{"webhook", "scheduler"} {
		t.Run(source, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			_, err := f.Pool.Exec(ctx, `INSERT INTO github_installation(id,account_login,workspace_id,ownership_verified_at) VALUES(99,'acme',$1,now())`, f.WorkspaceID)
			require.NoError(t, err)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/app/installations/99/access_tokens" {
					json.NewEncoder(w).Encode(map[string]any{"token": "temporary-token", "expires_at": time.Now().Add(time.Hour)})
					return
				}
				require.Equal(t, "/installation/repositories", r.URL.Path)
				fmt.Fprint(w, `{"total_count":0,"repositories":[]}`)
			}))
			defer srv.Close()
			wk := testutil.NewWorker(t, f, srv)
			if source == "scheduler" {
				require.NoError(t, wk.Reconcile(ctx))
			} else {
				_, err = f.Pool.Exec(ctx, `INSERT INTO github_event(delivery_id,event_type,payload) VALUES('verified','installation_repositories','{"action":"added","installation":{"id":99,"account":{"login":"acme"}}}')`)
				require.NoError(t, err)
				require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error {
					return f.Store.EnqueueJob(ctx, tx, "process_delivery", map[string]string{"delivery_id": "verified"})
				}))
				_, err = wk.ProcessOnce(ctx)
				require.NoError(t, err)
			}
			require.NoError(t, wk.Reconcile(ctx)) // an already queued request is not superseded by the scheduler
			var count, generation int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*),max((payload->>'generation')::int) FROM job WHERE kind='sync_installation_repos'`).Scan(&count, &generation))
			require.Equal(t, 1, count)
			require.Equal(t, 1, generation)
			_, err = wk.ProcessOnce(ctx)
			require.NoError(t, err)
			status, err := f.Store.GitHubStatus(ctx, f.WorkspaceID)
			require.NoError(t, err)
			require.Equal(t, "connected", status.Status)
		})
	}
}
