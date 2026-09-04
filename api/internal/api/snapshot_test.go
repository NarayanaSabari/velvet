package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestClosingASprintFreezesItsNumbers(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	issue := createIssue(t, f, map[string]any{
		"title": "Work", "milestone_id": m.ID.String(), "status": "done"})

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/snapshot", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var snap store.SprintSnapshot
	f.DecodeInto(rec, &snap)
	require.Equal(t, 1, snap.MilestonesPlanned)
	require.Equal(t, 1, snap.IssueCounts["done"])

	// Editing history after the close must not change the frozen report.
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
			map[string]any{"status": "cancelled"}).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/snapshot", nil)
	f.DecodeInto(rec, &snap)
	require.Equal(t, 1, snap.IssueCounts["done"],
		"a later edit must not silently rewrite last month's report")
}

func TestIncompleteIssuesRollForward(t *testing.T) {
	f := testutil.NewFixture(t)

	sept := newSprint(t, f)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "October", "starts_on": "2026-10-01", "ends_on": "2026-10-31"})
	var oct store.Sprint
	f.DecodeInto(rec, &oct)

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/activate", nil).Code)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	unfinished := createIssue(t, f, map[string]any{
		"title": "Not done", "milestone_id": m.ID.String(), "status": "in_progress"})

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/close", nil).Code)

	// The issue must still be reachable and still open, now under October.
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+unfinished.Key, nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Equal(t, "in_progress", got.Status,
		"rolling forward must not silently complete or cancel work")

	// It moved into a milestone that belongs to the next sprint, so the work
	// is carried rather than orphaned.
	require.NotNil(t, got.MilestoneID)
	var sprintID string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT sprint_id FROM milestone WHERE id = $1`, *got.MilestoneID).Scan(&sprintID))
	require.Equal(t, oct.ID.String(), sprintID)
}

// Without a next sprint there is nowhere honest to move the work, so it stays
// put rather than the close inventing a sprint nobody planned.
func TestRollForwardLeavesWorkAloneWithoutAnUpcomingSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	issue := createIssue(t, f, map[string]any{
		"title": "Still open", "milestone_id": m.ID.String(), "status": "todo"})

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Equal(t, "todo", got.Status)
	require.NotNil(t, got.MilestoneID)
	require.Equal(t, m.ID, *got.MilestoneID)
}

func TestSnapshotIsWorkspaceScoped(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil).Code)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	var otherSprint string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
		VALUES ($1, 'Foreign', '2026-09-01', '2026-09-30') RETURNING id`, otherWS).Scan(&otherSprint))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO sprint_snapshot (sprint_id, workspace_id, milestones_planned,
			milestones_completed, issue_counts, person_totals)
		VALUES ($1, $2, 7, 7, '{}'::jsonb, '{}'::jsonb)`, otherSprint, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+otherSprint+"/snapshot", nil)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}
