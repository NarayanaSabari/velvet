package store_test

import (
	"context"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestEffectiveGitHubIdentityConcurrentFallbackAndScopedClaim(t *testing.T) {
	for _, mutation := range []string{"global-link", "remove-override"} {
		t.Run(mutation, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			other, err := f.Store.UpsertUserByEmail(ctx, "other@example.com")
			require.NoError(t, err)
			_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, other.ID)
			require.NoError(t, err)
			shared := store.GitHubIdentity{ID: 42, Login: "shared"}
			var change func() error
			if mutation == "global-link" {
				state, _, err := f.Store.CreateGitHubLinkAuthorization(ctx, f.Token, f.User.ID, uuid.Nil)
				require.NoError(t, err)
				a, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "link")
				require.NoError(t, err)
				change = func() error { return f.Store.CompleteGitHubLink(context.Background(), a, shared) }
			} else {
				shared = store.GitHubIdentity{ID: *f.User.GitHubID, Login: *f.User.GitHubLogin}
				require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
					store.GitHubIdentity{ID: 2002, Login: "override"}))
				change = func() error {
					return f.Store.UnlinkMembershipGitHubIdentity(context.Background(), f.WorkspaceID, f.User.ID)
				}
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() {
				<-start
				results <- change()
			}()
			go func() {
				<-start
				results <- f.Store.LinkMembershipGitHubIdentity(context.Background(), f.WorkspaceID, other.ID, shared)
			}()
			close(start)
			won := 0
			for range 2 {
				if err := <-results; err == nil {
					won++
				} else {
					require.ErrorIs(t, err, store.ErrDuplicate)
				}
			}
			if mutation == "global-link" {
				require.Equal(t, 1, won)
			} else {
				require.GreaterOrEqual(t, won, 1)
			}
			var owners int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM membership m JOIN app_user u ON u.id=m.user_id
				LEFT JOIN membership_github_identity gi ON gi.membership_id=m.id
				WHERE m.workspace_id=$1 AND COALESCE(gi.github_id,u.github_id)=$2
				  AND (gi.membership_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM membership_github_identity claimed WHERE claimed.workspace_id=m.workspace_id AND claimed.github_id=u.github_id))`, f.WorkspaceID, shared.ID).Scan(&owners))
			require.Equal(t, 1, owners)
		})
	}
}

func TestGlobalGitHubLinkChecksOnlyOrganisationsUsingFallback(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	other, err := f.Store.UpsertUserByEmail(ctx, "other@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, other.ID)
	require.NoError(t, err)
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, other.ID,
		store.GitHubIdentity{ID: 42, Login: "shared"}))
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "owner-override"}))
	state, _, err := f.Store.CreateGitHubLinkAuthorization(ctx, f.Token, f.User.ID, uuid.Nil)
	require.NoError(t, err)
	a, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "link")
	require.NoError(t, err)
	require.NoError(t, f.Store.CompleteGitHubLink(ctx, a, store.GitHubIdentity{ID: 42, Login: "shared"}))
	identity, err := f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2002), identity.GitHubID)
	require.NoError(t, f.Store.UnlinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID))
	_, err = f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, f.User.ID)
	require.ErrorIs(t, err, store.ErrNotFound)
}
