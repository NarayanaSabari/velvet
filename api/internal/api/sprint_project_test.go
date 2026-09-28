package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// sprintFor creates a sprint in one project and returns it.
func sprintFor(t *testing.T, f *testutil.Fixture, project store.Project, name, from, to string) store.Sprint {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": name, "starts_on": from, "ends_on": to, "project_id": project.ID.String()})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var s store.Sprint
	f.DecodeInto(rec, &s)
	return s
}

func milestoneIn(t *testing.T, f *testutil.Fixture, sprint store.Sprint, name string) store.Milestone {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": name})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var m store.Milestone
	f.DecodeInto(rec, &m)
	return m
}

// A sprint belongs to exactly one project, named by id or key, and cannot be
// created without one.
func TestASprintBelongsToAProject(t *testing.T) {
	f := testutil.NewFixture(t)
	web := createProject(t, f, map[string]any{"key": "web", "name": "Web"})

	sprint := sprintFor(t, f, web, "Web September", "2026-09-01", "2026-09-30")
	require.Equal(t, web.ID, sprint.ProjectID)

	// Agents know a project by key.
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Web October", "starts_on": "2026-10-01", "ends_on": "2026-10-31", "project": "web"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var byKey store.Sprint
	f.DecodeInto(rec, &byKey)
	require.Equal(t, web.ID, byKey.ProjectID)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Nowhere", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "a sprint belongs to a project")

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Unknown", "starts_on": "2026-09-01", "ends_on": "2026-09-30", "project": "nope"})
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())

	foreign := testutil.CreateForeignProject(t, f, "theirs")
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Borrowed", "starts_on": "2026-09-01", "ends_on": "2026-09-30", "project_id": foreign.String()})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"a project from another organisation must not own a sprint here")
}

func TestSprintsCanBeListedForOneProject(t *testing.T) {
	f := testutil.NewFixture(t)
	web := createProject(t, f, map[string]any{"key": "web", "name": "Web"})
	api := createProject(t, f, map[string]any{"key": "api", "name": "API"})
	sprintFor(t, f, web, "Web September", "2026-09-01", "2026-09-30")
	sprintFor(t, f, api, "API September", "2026-09-01", "2026-09-30")

	for _, query := range []string{"?project=api", "?project_id=" + api.ID.String()} {
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints"+query, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var list struct {
			Sprints []store.Sprint `json:"sprints"`
		}
		f.DecodeInto(rec, &list)
		require.Len(t, list.Sprints, 1, query)
		require.Equal(t, "API September", list.Sprints[0].Name)
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	var all struct {
		Sprints []store.Sprint `json:"sprints"`
	}
	f.DecodeInto(rec, &all)
	require.Len(t, all.Sprints, 2)
}

// Each project runs its own sprint: activating one project's sprint must not
// complete another project's, and the dashboard shows both.
func TestEachProjectRunsItsOwnActiveSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	web := createProject(t, f, map[string]any{"key": "web", "name": "Web"})
	api := createProject(t, f, map[string]any{"key": "api", "name": "API"})
	webSep := sprintFor(t, f, web, "Web September", "2026-09-01", "2026-09-30")
	webOct := sprintFor(t, f, web, "Web October", "2026-10-01", "2026-10-31")
	apiSep := sprintFor(t, f, api, "API September", "2026-09-01", "2026-09-30")
	milestoneIn(t, f, apiSep, "Ship the API")

	activate := func(s store.Sprint) {
		t.Helper()
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/activate", nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	state := func(s store.Sprint) string {
		t.Helper()
		var st string
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT state FROM sprint WHERE id = $1`, s.ID).Scan(&st))
		return st
	}

	activate(webSep)
	activate(apiSep)
	require.Equal(t, "active", state(webSep), "another project's sprint must not complete this one")
	require.Equal(t, "active", state(apiSep))

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/dashboard", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var dash store.DashboardPayload
	f.DecodeInto(rec, &dash)
	require.Len(t, dash.ActiveSprints, 2)
	require.Equal(t, "API", dash.ActiveSprints[0].ProjectName, "ordered by project name")
	require.Equal(t, "api", dash.ActiveSprints[0].ProjectKey)
	require.Len(t, dash.ActiveSprints[0].Milestones, 1)
	require.Equal(t, "Web", dash.ActiveSprints[1].ProjectName)
	require.Empty(t, dash.ActiveSprints[1].Milestones)

	// Within one project, the next sprint still completes the current one.
	activate(webOct)
	require.Equal(t, "completed", state(webSep))
	require.Equal(t, "active", state(webOct))
	require.Equal(t, "active", state(apiSep))
}

// Closing a sprint carries unfinished work into the same project's next
// sprint, never into another project's.
func TestClosingASprintCarriesWorkWithinItsProject(t *testing.T) {
	f := testutil.NewFixture(t)
	web := createProject(t, f, map[string]any{"key": "web", "name": "Web"})
	api := createProject(t, f, map[string]any{"key": "api", "name": "API"})
	webSep := sprintFor(t, f, web, "Web September", "2026-09-01", "2026-09-30")
	// Another project's upcoming sprint starts sooner, which is exactly what
	// a workspace-wide roll-forward would have picked.
	sprintFor(t, f, api, "API late September", "2026-09-20", "2026-10-20")
	webOct := sprintFor(t, f, web, "Web October", "2026-10-01", "2026-10-31")
	goal := milestoneIn(t, f, webSep, "Redesign")
	issue := createIssue(t, f, map[string]any{"title": "Unfinished", "milestone_id": goal.ID.String()})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+webSep.ID.String()+"/close", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var sprintID string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT m.sprint_id::text FROM issue i JOIN milestone m ON m.id = i.milestone_id WHERE i.id = $1`,
		issue.ID).Scan(&sprintID))
	require.Equal(t, webOct.ID.String(), sprintID)
}

// A ticket's milestone and project always agree, from whichever side it is set.
func TestATicketsMilestoneAndProjectStayInStep(t *testing.T) {
	f := testutil.NewFixture(t)
	web := createProject(t, f, map[string]any{"key": "web", "name": "Web"})
	api := createProject(t, f, map[string]any{"key": "api", "name": "API"})
	webGoal := milestoneIn(t, f, sprintFor(t, f, web, "Web September", "2026-09-01", "2026-09-30"), "Web goal")
	apiGoal := milestoneIn(t, f, sprintFor(t, f, api, "API September", "2026-09-01", "2026-09-30"), "API goal")

	patch := func(key string, body map[string]any) store.Issue {
		t.Helper()
		rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+key, body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var i store.Issue
		f.DecodeInto(rec, &i)
		return i
	}

	// Creating in a milestone files the ticket under its project.
	created := createIssue(t, f, map[string]any{"title": "In a goal", "milestone_id": webGoal.ID.String()})
	require.Equal(t, web.ID, *created.ProjectID)

	// Even when a conflicting project is sent alongside, the milestone wins.
	mixed := createIssue(t, f, map[string]any{
		"title": "Mixed", "milestone_id": webGoal.ID.String(), "project_id": api.ID.String()})
	require.Equal(t, web.ID, *mixed.ProjectID)

	// Choosing a milestone moves the ticket to that milestone's project.
	loose := createIssue(t, f, map[string]any{"title": "Loose"})
	require.Nil(t, loose.ProjectID)
	moved := patch(loose.Key, map[string]any{"milestone_id": apiGoal.ID.String()})
	require.Equal(t, apiGoal.ID, *moved.MilestoneID)
	require.Equal(t, api.ID, *moved.ProjectID)

	// Choosing another project on its own takes the ticket out of a milestone
	// that belongs to a different project.
	rehomed := patch(loose.Key, map[string]any{"project_id": web.ID.String()})
	require.Equal(t, web.ID, *rehomed.ProjectID)
	require.Nil(t, rehomed.MilestoneID)

	// Choosing the same project keeps the milestone.
	kept := patch(created.Key, map[string]any{"project_id": web.ID.String()})
	require.Equal(t, webGoal.ID, *kept.MilestoneID)

	// Clearing the milestone keeps the project.
	cleared := patch(created.Key, map[string]any{"milestone_id": nil})
	require.Nil(t, cleared.MilestoneID)
	require.Equal(t, web.ID, *cleared.ProjectID)

	// The implied project change is in the record like any other.
	var moves int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT count(*) FROM activity WHERE target_id = $1 AND verb = $2`, loose.ID, store.VerbMovedIssueProject).Scan(&moves))
	require.Equal(t, 2, moves)
}
