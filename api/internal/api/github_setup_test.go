package api_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// Exercise connect through PKCE callback against PostgreSQL and observe the committed job.
func TestGitHubSetupBoundInstallationRoundtrip(t *testing.T) {
	f := testutil.NewFixture(t)
	stub := newGitHubAuthStub(t)
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080", GitHubAppSlug: "velvet", GitHubInstallationURL: "http://localhost:18499/install"}, api.Dependencies{GitHubUser: stub.client, CompleteGitHubInstallation: f.Store.BindInstallation}).Handler()
	start := githubRequest(h, "GET", "/api/v1/w/lab/github/connect", f.Token)
	require.Equal(t, 302, start.Code, start.Body.String())
	target, err := url.Parse(start.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "localhost:18499", target.Host)
	require.Equal(t, "/install", target.Path)
	require.Len(t, target.Query().Get("state"), 43)
	setup := githubRequest(h, "GET", "/api/v1/github/setup?installation_id=99&state="+target.Query().Get("state"), f.Token)
	require.Equal(t, 302, setup.Code, setup.Body.String())
	callback := githubCallback(t, setup.Header().Get("Location"))
	done := githubRequest(h, "GET", callback, f.Token)
	require.Equal(t, 302, done.Code, done.Body.String())
	require.Equal(t, "/w/lab/admin", done.Header().Get("Location"))
	require.Equal(t, 302, githubRequest(h, "GET", callback, f.Token).Code)
	status := githubRequest(h, "GET", "/api/v1/w/lab/github", f.Token)
	require.Equal(t, 200, status.Code)
	require.Contains(t, status.Body.String(), `"status":"syncing"`)
	var generation, jobs int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT sync_generation,(SELECT count(*) FROM job WHERE kind='sync_installation_repos') FROM github_installation WHERE id=99`).Scan(&generation, &jobs))
	require.Equal(t, 1, generation)
	require.Equal(t, 1, jobs)
	retry := githubRequest(h, "POST", "/api/v1/w/lab/github/sync", f.Token)
	require.Equal(t, 202, retry.Code, retry.Body.String())
	require.Equal(t, 1, stub.exchanges)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT sync_generation FROM github_installation WHERE id=99`).Scan(&generation))
	require.Equal(t, 2, generation)
}

func TestGitHubSetupStatusLegacyGateAndRoles(t *testing.T) {
	f := testutil.NewFixture(t)
	disconnected := f.Do("GET", "/api/v1/w/lab/github", nil)
	require.Equal(t, 200, disconnected.Code)
	require.JSONEq(t, `{"installation":null,"status":"disconnected","error":null}`, disconnected.Body.String())
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO github_installation(id,account_login,workspace_id) VALUES (99,'acme',$1)`, f.WorkspaceID)
	require.NoError(t, err)
	status := f.Do("GET", "/api/v1/w/lab/github", nil)
	require.Equal(t, 200, status.Code)
	require.Contains(t, status.Body.String(), `"error":"verification_required"`)
	retry := f.Do("POST", "/api/v1/w/lab/github/sync", nil)
	require.Equal(t, 409, retry.Code)
	require.Contains(t, retry.Body.String(), `"code":"verification_required"`)
	_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role='member' WHERE user_id=$1`, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, 200, f.Do("GET", "/api/v1/w/lab/github", nil).Code)
	require.Equal(t, 403, f.Do("POST", "/api/v1/w/lab/github/sync", nil).Code)
	require.Equal(t, 403, f.Do("GET", "/api/v1/w/lab/github/connect", nil).Code)
}

// Installation verification must not link a profile or record success before the final transaction commits.
func TestGitHubSetupCompletionBoundary(t *testing.T) {
	for _, mode := range []string{"complete", "rollback", "demoted", "unavailable", "missing-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			stub := newGitHubAuthStub(t)
			deps := api.Dependencies{GitHubUser: stub.client}
			if mode != "unavailable" {
				deps.CompleteGitHubInstallation = func(ctx context.Context, a store.GitHubAuthorization, evidence github.VerifiedInstallation) error {
					if mode == "missing-receipt" {
						return nil
					}
					require.Empty(t, a.Verifier)
					require.Equal(t, int64(99), evidence.ID)
					require.Equal(t, int64(42), evidence.AccountID)
					if mode == "demoted" {
						_, err := f.Pool.Exec(ctx, `UPDATE membership SET role='member' WHERE user_id=$1`, f.User.ID)
						require.NoError(t, err)
					}
					return f.Store.InTx(ctx, func(tx pgx.Tx) error {
						if err := store.LockGitHubInstallationAuthorizationTx(ctx, tx, a); err != nil {
							return err
						}
						if err := store.CompleteGitHubInstallationAuthorizationTx(ctx, tx, a); err != nil {
							return err
						}
						if mode == "rollback" {
							return store.ErrForeignReference
						}
						return nil
					})
				}
			}
			h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, deps).Handler()
			setup, err := f.Store.CreateGitHubSetup(t.Context(), f.Token, f.User.ID, f.WorkspaceID)
			require.NoError(t, err)
			path := "/api/v1/github/setup?installation_id=99&state=" + setup
			first := githubRequest(h, http.MethodGet, path, f.Token)
			if mode == "unavailable" {
				require.Equal(t, 503, first.Code)
				var n int
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM github_authorization_state`).Scan(&n))
				require.Zero(t, n)
				return
			}
			require.Equal(t, 302, first.Code, first.Body.String())
			callback := githubCallback(t, first.Header().Get("Location"))
			result := githubRequest(h, "GET", callback, f.Token)
			if mode == "complete" {
				require.Equal(t, 302, result.Code, result.Body.String())
				require.Equal(t, "/w/lab/admin", result.Header().Get("Location"))
				require.Equal(t, 302, githubRequest(h, "GET", callback, f.Token).Code)
				replay := githubRequest(h, "GET", path, f.Token)
				require.Equal(t, 302, replay.Code)
				require.Equal(t, "/w/lab/admin", replay.Header().Get("Location"))
			} else {
				require.GreaterOrEqual(t, result.Code, 400)
				var n int
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM github_authorization_state WHERE completed_at IS NOT NULL)+(SELECT count(*) FROM github_setup_state WHERE completed_at IS NOT NULL)`).Scan(&n))
				require.Zero(t, n)
				require.Equal(t, 410, githubRequest(h, "GET", callback, f.Token).Code)
			}
			require.Equal(t, 1, stub.exchanges)
			user, err := f.Store.UserBySessionToken(t.Context(), f.Token)
			require.NoError(t, err)
			require.Equal(t, *f.User.GitHubID, *user.GitHubID)
		})
	}
}
