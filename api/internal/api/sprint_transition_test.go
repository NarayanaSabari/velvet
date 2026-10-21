package api_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestActivationClosesPreviousSprintAndCarriesToChosenSprint(t *testing.T) {
	for _, failCarry := range []bool{false, true} {
		name := "success"
		if failCarry {
			name = "rollback on carry failure"
		}
		t.Run(name, func(t *testing.T) {
			f := testutil.NewFixture(t)
			project := createProject(t, f, map[string]any{"key": "web", "name": "Web"})
			previous := sprintFor(t, f, project, "September", "2026-09-01", "2026-09-30")
			skipped := sprintFor(t, f, project, "Early October", "2026-10-01", "2026-10-14")
			chosen := sprintFor(t, f, project, "Late October", "2026-10-15", "2026-10-31")
			goal := milestoneIn(t, f, previous, "Ship auth")
			target := milestoneIn(t, f, chosen, "Ship auth")
			open := createIssue(t, f, map[string]any{"title": "Unfinished", "status": "in_progress", "milestone_id": goal.ID.String()})
			done := createIssue(t, f, map[string]any{"title": "Finished", "status": "done", "milestone_id": goal.ID.String()})
			base := "/api/v1/w/lab/sprints/"
			require.Equal(t, http.StatusOK, f.Do(http.MethodPost, base+previous.ID.String()+"/activate", nil).Code)
			if failCarry {
				_, err := f.Pool.Exec(t.Context(), `
					CREATE FUNCTION reject_carry() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'carry failed'; END $$;
					CREATE TRIGGER reject_carry BEFORE UPDATE OF milestone_id ON issue
					FOR EACH ROW EXECUTE FUNCTION reject_carry()`)
				require.NoError(t, err)
			}

			rec := f.Do(http.MethodPost, base+chosen.ID.String()+"/activate", nil)
			if failCarry {
				require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
			} else {
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			}
			old, err := f.Store.GetSprint(t.Context(), f.WorkspaceID, previous.ID)
			require.NoError(t, err)
			next, err := f.Store.GetSprint(t.Context(), f.WorkspaceID, chosen.ID)
			require.NoError(t, err)
			unchosen, err := f.Store.GetSprint(t.Context(), f.WorkspaceID, skipped.ID)
			require.NoError(t, err)
			require.Equal(t, "upcoming", unchosen.State)
			got, err := f.Store.GetIssueByKey(t.Context(), f.WorkspaceID, open.Key)
			require.NoError(t, err)
			require.Equal(t, "in_progress", got.Status)
			finished, err := f.Store.GetIssueByKey(t.Context(), f.WorkspaceID, done.Key)
			require.NoError(t, err)
			require.Equal(t, goal.ID, *finished.MilestoneID)
			snapshot, err := f.Store.GetSnapshot(t.Context(), f.WorkspaceID, previous.ID)
			if failCarry {
				require.ErrorIs(t, err, store.ErrNotFound)
				require.Equal(t, "active", old.State)
				require.Nil(t, old.CompletedAt)
				require.Equal(t, "upcoming", next.State)
				require.Equal(t, goal.ID, *got.MilestoneID)
			} else {
				require.NoError(t, err)
				require.Equal(t, "completed", old.State)
				require.NotNil(t, old.CompletedAt)
				require.Equal(t, "active", next.State)
				require.Equal(t, target.ID, *got.MilestoneID)
				require.Equal(t, 1, snapshot.IssueCounts["in_progress"])
				require.Equal(t, 1, snapshot.IssueCounts["done"])
			}
			var closures int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE target_id=$1 AND verb=$2`, previous.ID, store.VerbClosedSprint).Scan(&closures))
			if failCarry {
				require.Zero(t, closures)
			} else {
				require.Equal(t, 1, closures)
				// Repeating activation must not close or carry the same sprint again.
				require.Equal(t, http.StatusOK, f.Do(http.MethodPost, base+chosen.ID.String()+"/activate", nil).Code)
				var destination uuid.UUID
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT milestone_id FROM issue WHERE id=$1`, open.ID).Scan(&destination))
				require.Equal(t, target.ID, destination)
			}
		})
	}
}
