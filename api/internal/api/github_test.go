package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestEvidenceEndpointReturnsAttachedPRs(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "merged")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var ev store.Evidence
	f.DecodeInto(rec, &ev)
	require.Len(t, ev.PullRequests, 1)
	require.Equal(t, 42, ev.PullRequests[0].Number)
}

func TestManualAttachRecordsActivityAndIsIdempotent(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "open")

	body := map[string]any{"pull_request_id": pr.ID.String()}
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs", body).Code)
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs", body).Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbAttachedPR, issue.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestManualAttachDoesNotChangeStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "merged")

	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs",
			map[string]any{"pull_request_id": pr.ID.String()}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Equal(t, "backlog", got.Status)
}

func TestUnlinkRemovesTheEvidenceLink(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "open")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))

	require.Equal(t, http.StatusNoContent,
		f.Do(http.MethodDelete,
			"/api/v1/w/lab/issues/"+issue.Key+"/prs/"+pr.ID.String(), nil).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
	var ev store.Evidence
	f.DecodeInto(rec, &ev)
	require.Empty(t, ev.PullRequests)
}

func TestUnlinkedListShowsUnmatchedPRs(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.InsertPullRequest(t, f, 42, "Stray PR", "open")

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/pull-requests/unlinked", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "Stray PR")
}

func TestPullRequestOfAnotherWorkspaceCannotBeAttached(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	foreign := testutil.InsertForeignPullRequest(t, f, 99, "Foreign")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs",
		map[string]any{"pull_request_id": foreign.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
