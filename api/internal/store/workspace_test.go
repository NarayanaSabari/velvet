package store_test

import (
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Permission must be re-read after acquiring the workspace lock, not before waiting.
func TestOrganisationMutationRechecksActorAfterWorkspaceLock(t *testing.T) {
	for _, action := range []string{"role", "invite", "resend", "revoke", "remove", "delete"} {
		t.Run(action, func(t *testing.T) {
			f := testutil.NewFixture(t)
			i, _, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "new@example.com", "member")
			require.NoError(t, err)
			var memberID uuid.UUID
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM membership WHERE user_id=$1`, f.User.ID).Scan(&memberID))
			tx, err := f.Pool.Begin(t.Context())
			require.NoError(t, err)
			defer tx.Rollback(t.Context())
			_, err = tx.Exec(t.Context(), `SELECT id FROM workspace WHERE id=$1 FOR UPDATE`, f.WorkspaceID)
			require.NoError(t, err)
			done := make(chan error, 1)
			go func() {
				var err error
				switch action {
				case "role":
					_, err = f.Store.UpdateWorkspaceMembershipRole(t.Context(), f.WorkspaceID, memberID, f.User.ID, "admin")
				case "invite":
					_, _, err = f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "next@example.com", "member")
				case "resend":
					_, _, err = f.Store.ReplaceInvite(t.Context(), f.WorkspaceID, i.ID, f.User.ID, "viewer")
				case "revoke":
					err = f.Store.RevokeInvite(t.Context(), f.WorkspaceID, i.ID, f.User.ID)
				case "remove":
					err = f.Store.RemoveWorkspaceMembership(t.Context(), f.WorkspaceID, memberID, f.User.ID)
				case "delete":
					err = f.Store.DeleteWorkspace(t.Context(), f.WorkspaceID, f.User.ID)
				}
				done <- err
			}()
			require.Eventually(t, func() bool {
				var waiting bool
				err := f.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
				return err == nil && waiting
			}, time.Second, 10*time.Millisecond)
			_, err = tx.Exec(t.Context(), `UPDATE membership SET role='viewer' WHERE user_id=$1`, f.User.ID)
			require.NoError(t, err)
			require.NoError(t, tx.Commit(t.Context()))
			require.ErrorIs(t, <-done, store.ErrForbidden)
		})
	}
}

func TestOrganisationCreationRollsBackWithoutCreator(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Store.CreateWorkspace(t.Context(), uuid.New(), "Invalid creator", "invalid-creator", "IC")
	require.Error(t, err)
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace WHERE slug='invalid-creator'`).Scan(&count))
	require.Zero(t, count)
}

func TestUpdateWorkspaceNameReturnsTheUpdatedWorkspaceAndRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)

	workspace, err := f.Store.UpdateWorkspaceName(t.Context(), f.WorkspaceID, f.User.ID, "Velvet Otter")
	require.NoError(t, err)
	require.Equal(t, f.WorkspaceID, workspace.ID)
	require.Equal(t, "Velvet Otter", workspace.Name)
	require.Equal(t, "lab", workspace.Slug)
	require.Equal(t, "ENG", workspace.IssuePrefix)

	var verb, targetType string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT verb,target_type FROM activity WHERE workspace_id=$1 ORDER BY id DESC LIMIT 1`, f.WorkspaceID).Scan(&verb, &targetType))
	require.Equal(t, store.VerbRenamedOrganisation, verb)
	require.Equal(t, "workspace", targetType)
}

func TestOrganisationRemovedActorCannotMutateOrLeave(t *testing.T) {
	f := testutil.NewFixture(t)
	var id uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM membership WHERE user_id=$1`, f.User.ID).Scan(&id))
	_, err := f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE id=$1`, id)
	require.NoError(t, err)
	require.ErrorIs(t, f.Store.LeaveWorkspace(t.Context(), f.WorkspaceID, f.User.ID), store.ErrNotFound)
	require.ErrorIs(t, f.Store.DeleteWorkspace(t.Context(), f.WorkspaceID, f.User.ID), store.ErrNotFound)
	require.ErrorIs(t, f.Store.RemoveWorkspaceMembership(t.Context(), f.WorkspaceID, id, f.User.ID), store.ErrNotFound)
	_, err = f.Store.UpdateWorkspaceMembershipRole(t.Context(), f.WorkspaceID, id, f.User.ID, "admin")
	require.ErrorIs(t, err, store.ErrNotFound)
}
