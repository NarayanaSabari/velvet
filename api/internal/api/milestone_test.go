package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func newSprint(t *testing.T, f *testutil.Fixture) store.Sprint {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var s store.Sprint
	f.DecodeInto(rec, &s)
	return s
}

func TestCreateMilestoneUnderSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth", "description": "OAuth end to end"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var m store.Milestone
	f.DecodeInto(rec, &m)
	require.Equal(t, "Ship auth", m.Name)
	require.Equal(t, "planned", m.Status)
	require.NotEmpty(t, m.Position)
}

func TestMilestonesAreOrderedByPosition(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	for _, name := range []string{"First", "Second", "Third"} {
		rec := f.Do(http.MethodPost,
			"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
			map[string]any{"name": name})
		require.Equal(t, http.StatusCreated, rec.Code)
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Milestones []store.Milestone `json:"milestones"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Milestones, 3)
	require.Equal(t, "First", list.Milestones[0].Name)
	require.Less(t, list.Milestones[0].Position, list.Milestones[1].Position)
	require.Less(t, list.Milestones[1].Position, list.Milestones[2].Position)
}

func TestListAllWorkspaceMilestonesForIssueFiling(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	for _, name := range []string{"Ship auth", "Ship billing"} {
		rec := f.Do(http.MethodPost,
			"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
			map[string]any{"name": name})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/milestones", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var list struct {
		Milestones []store.Milestone `json:"milestones"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Milestones, 2)
}

func TestCompletingAMilestoneRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/milestones/"+m.ID.String(),
		map[string]any{"status": "completed"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1`, m.ID).Scan(&verb))
	require.Equal(t, store.VerbCompletedMilestone, verb)
}

func TestMilestoneRejectsUnknownStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/milestones/"+m.ID.String(),
		map[string]any{"status": "almost"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestMilestoneTargetDateCanBeCleared(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	created := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth", "target_date": "2026-09-30"})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var milestone store.Milestone
	f.DecodeInto(created, &milestone)
	require.NotNil(t, milestone.TargetDate)

	updated := f.Do(http.MethodPatch, "/api/v1/w/lab/milestones/"+milestone.ID.String(),
		map[string]any{"target_date": ""})
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	f.DecodeInto(updated, &milestone)
	require.Nil(t, milestone.TargetDate)
}

func TestMilestoneRejectsOwnerFromAnotherWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	foreign, err := f.Store.UpsertUserByGitHub(t.Context(),
		store.GitHubIdentity{ID: 9998, Login: "foreign-owner"})
	require.NoError(t, err)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Secret owner", "owner_id": foreign.ID.String()})
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}
