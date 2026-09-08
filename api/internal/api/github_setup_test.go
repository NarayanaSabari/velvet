package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

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
