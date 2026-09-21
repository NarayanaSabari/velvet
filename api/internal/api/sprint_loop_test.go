package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// The loop a manager's instruction actually creates: name a sprint that does
// not exist yet, name the goal, file the work under it, and be able to show
// what happened afterwards.
func TestAnAgentCanBuildOutASprintItWasToldToWorkIn(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	token := f.AgentToken("coding agent")

	// An agent, not a browser session, drives all of this.
	rec := f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/sprints", token,
		map[string]any{"name": "September 2026", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var sprint store.Sprint
	f.DecodeInto(rec, &sprint)
	require.Equal(t, "upcoming", sprint.State,
		"a new sprint must not activate itself and displace the current one")

	rec = f.DoAsAgent(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", token,
		map[string]any{"name": "Ship the billing rewrite"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var milestone store.Milestone
	f.DecodeInto(rec, &milestone)

	rec = f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/issues", token,
		map[string]any{"title": "Migrate the invoice schema", "milestone_id": milestone.ID.String()})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var issue store.Issue
	f.DecodeInto(rec, &issue)
	require.NotNil(t, issue.MilestoneID)
	require.Equal(t, milestone.ID, *issue.MilestoneID)

	// The sprint filter is what makes "what is in this sprint" answerable.
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues?sprint_id="+sprint.ID.String(), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var listed struct {
		Issues []store.Issue `json:"issues"`
	}
	f.DecodeInto(rec, &listed)
	require.Len(t, listed.Issues, 1)
	require.Equal(t, issue.ID, listed.Issues[0].ID)

	// Every change is attributable, which is the condition for letting a
	// member do any of it.
	for _, tc := range []struct{ verb, target string }{
		{store.VerbCreatedSprint, "sprint"},
		{store.VerbCreatedMilestone, "milestone"},
		{store.VerbCreatedIssue, "issue"},
	} {
		var actor string
		require.NoError(t, f.Pool.QueryRow(ctx,
			`SELECT actor_id::text FROM activity WHERE verb = $1 AND target_type = $2`,
			tc.verb, tc.target).Scan(&actor), "%s must be recorded", tc.verb)
		require.Equal(t, f.User.ID.String(), actor, "%s must name who did it", tc.verb)
	}
}

// An existing ticket can be pulled into a sprint later, and dropped from it
// again, because plans change after work has already been filed.
func TestATicketCanBeScheduledIntoASprintAfterTheFact(t *testing.T) {
	f := testutil.NewFixture(t)

	issue := createIssue(t, f, map[string]any{"title": "Unscheduled work"})
	require.Nil(t, issue.MilestoneID)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints",
		map[string]any{"name": "October 2026", "starts_on": "2026-10-01", "ends_on": "2026-10-31"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var sprint store.Sprint
	f.DecodeInto(rec, &sprint)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Close the quarter"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var milestone store.Milestone
	f.DecodeInto(rec, &milestone)

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"milestone_id": milestone.ID.String()})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var scheduled store.Issue
	f.DecodeInto(rec, &scheduled)
	require.NotNil(t, scheduled.MilestoneID)
	require.Equal(t, milestone.ID, *scheduled.MilestoneID)

	// An explicit null drops it back out of the sprint rather than failing.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"milestone_id": nil})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var unscheduled store.Issue
	f.DecodeInto(rec, &unscheduled)
	require.Nil(t, unscheduled.MilestoneID)
}

// An explicit null must clear a reference. The handler documented this
// behaviour but a *string decoded both "absent" and "null" to nil, so
// detaching an assignee, milestone, project, or parent silently did nothing.
func TestAnExplicitNullClearsAReference(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	sprint, err := f.Store.CreateSprint(ctx, store.CreateSprintInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID,
		Name: "September 2026", StartsOn: "2026-09-01", EndsOn: "2026-09-30"})
	require.NoError(t, err)
	milestone, err := f.Store.CreateMilestone(ctx, store.CreateMilestoneInput{
		WorkspaceID: f.WorkspaceID, SprintID: sprint.ID, ActorID: f.User.ID,
		Name: "Ship it"})
	require.NoError(t, err)

	issue := createIssue(t, f, map[string]any{
		"title":        "Fully referenced",
		"project":      "velvet",
		"assignee_id":  f.User.ID.String(),
		"milestone_id": milestone.ID.String(),
	})
	require.NotNil(t, issue.AssigneeID)
	require.NotNil(t, issue.MilestoneID)
	require.NotNil(t, issue.ProjectID)

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key, map[string]any{
		"assignee_id": nil, "milestone_id": nil, "project_id": nil,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var cleared store.Issue
	f.DecodeInto(rec, &cleared)
	require.Nil(t, cleared.AssigneeID, "an explicit null must unassign")
	require.Nil(t, cleared.MilestoneID, "an explicit null must unschedule")
	require.Nil(t, cleared.ProjectID, "an explicit null must unfile")

	// Omitting a field still leaves it alone, which is the other half of the
	// contract and the reason the two must stay distinguishable.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"milestone_id": milestone.ID.String()})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"title": "Renamed only"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var untouched store.Issue
	f.DecodeInto(rec, &untouched)
	require.Equal(t, "Renamed only", untouched.Title)
	require.NotNil(t, untouched.MilestoneID, "an omitted field must not be cleared")
	require.Equal(t, milestone.ID, *untouched.MilestoneID)

	// Junk is still a client error rather than a silent no-op.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"milestone_id": "not-a-uuid"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// A milestone belongs to one organisation's sprint, and a valid UUID from
// another must not be usable as a parent.
func TestAMilestoneCannotBeCreatedUnderAnotherOrganisationsSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	sprint, err := f.Store.CreateSprint(ctx, store.CreateSprintInput{
		WorkspaceID: clientWS, ActorID: f.User.ID,
		Name: "Theirs", StartsOn: "2026-09-01", EndsOn: "2026-09-30"})
	require.NoError(t, err)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Smuggled"})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"another organisation's sprint must not accept a milestone here")
}
