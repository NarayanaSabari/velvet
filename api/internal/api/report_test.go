package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestStaleReportFindsSilentInProgressWork(t *testing.T) {
	f := testutil.NewFixture(t)

	fresh := createIssue(t, f, map[string]any{"title": "Fresh", "status": "in_progress"})
	stale := createIssue(t, f, map[string]any{"title": "Stale", "status": "in_progress"})
	createIssue(t, f, map[string]any{"title": "Done thing", "status": "done"})

	// Age the stale issue's activity past the threshold.
	_, err := f.Pool.Exec(t.Context(), `
		UPDATE activity SET created_at = now() - interval '30 days'
		WHERE target_id = $1`, stale.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		UPDATE issue SET updated_at = now() - interval '30 days' WHERE id = $1`, stale.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var out struct {
		Issues []store.StaleIssueRow `json:"issues"`
	}
	f.DecodeInto(rec, &out)
	require.Len(t, out.Issues, 1)
	require.Equal(t, stale.Key, out.Issues[0].Key)
	require.NotEqual(t, fresh.Key, out.Issues[0].Key)
}

func TestStaleReportIgnoresDoneAndCancelled(t *testing.T) {
	f := testutil.NewFixture(t)
	old := createIssue(t, f, map[string]any{"title": "Old but done", "status": "done"})

	_, err := f.Pool.Exec(t.Context(), `
		UPDATE issue SET updated_at = now() - interval '90 days' WHERE id = $1`, old.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	var out struct {
		Issues []store.StaleIssueRow `json:"issues"`
	}
	f.DecodeInto(rec, &out)
	require.Empty(t, out.Issues, "finished work is not stalled work")
}

// A pull request pushed yesterday is a real signal of life, so an issue
// carrying one is not stalled however long the conversation has been quiet.
func TestStaleReportCountsPullRequestActivityAsASignal(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Has a live PR", "status": "in_progress"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "open")

	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs",
			map[string]any{"pull_request_id": pr.ID.String()}).Code)

	_, err := f.Pool.Exec(t.Context(), `
		UPDATE activity SET created_at = now() - interval '60 days'`)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		UPDATE issue SET updated_at = now() - interval '60 days' WHERE id = $1`, issue.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		UPDATE pull_request SET gh_updated_at = now() - interval '1 day' WHERE id = $1`, pr.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	var out struct {
		Issues []store.StaleIssueRow `json:"issues"`
	}
	f.DecodeInto(rec, &out)
	require.Empty(t, out.Issues, "a PR pushed yesterday is not stalled work")
}

func TestPersonActivityCountsPerMember(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
			map[string]any{"body": "An update"}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/activity", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var out struct {
		People []store.PersonActivityRow `json:"people"`
	}
	f.DecodeInto(rec, &out)
	require.Len(t, out.People, 1)
	require.Equal(t, "sabari", out.People[0].GitHubLogin)
	require.GreaterOrEqual(t, out.People[0].Total, 2)
	require.Equal(t, 1, out.People[0].Verbs[store.VerbCommented])
}

func TestMilestoneCompletionAndClosedPerSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var m store.Milestone
	f.DecodeInto(rec, &m)

	createIssue(t, f, map[string]any{
		"title": "Done work", "milestone_id": m.ID.String(), "status": "done"})
	createIssue(t, f, map[string]any{
		"title": "Open work", "milestone_id": m.ID.String(), "status": "in_progress"})

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/reports/milestones", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var milestones struct {
		Sprints []store.MilestoneCompletionRow `json:"sprints"`
	}
	f.DecodeInto(rec, &milestones)
	require.Len(t, milestones.Sprints, 1)
	require.Equal(t, sprint.Name, milestones.Sprints[0].SprintName)
	require.Equal(t, 1, milestones.Sprints[0].Planned)
	require.Equal(t, 0, milestones.Sprints[0].Completed)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/reports/closed", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var closed struct {
		Sprints []store.SprintClosedRow `json:"sprints"`
	}
	f.DecodeInto(rec, &closed)
	require.Len(t, closed.Sprints, 1)
	require.Equal(t, 1, closed.Sprints[0].Closed)
	require.Equal(t, 2, closed.Sprints[0].Total)
}

func TestReportsAreWorkspaceScoped(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO issue (workspace_id, key, number, title, position, status)
		VALUES ($1, 'ENG-1', 1, 'Foreign stale', 'V', 'in_progress')`, otherWS)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`UPDATE issue SET updated_at = now() - interval '90 days' WHERE workspace_id = $1`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	require.NotContains(t, rec.Body.String(), "Foreign stale")
}
