package worker_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

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
