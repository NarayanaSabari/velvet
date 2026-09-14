package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
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

func TestRepositoryListRetainsDisconnectedHistory(t *testing.T) {
	f := testutil.NewFixture(t)
	pr := testutil.InsertPullRequest(t, f, 42, "Retained evidence", "open")
	read := func() map[string]any {
		t.Helper()
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/repos", nil)
		require.Equal(t, http.StatusOK, rec.Code)
		var body struct {
			Repos []map[string]any `json:"repos"`
		}
		f.DecodeInto(rec, &body)
		require.Len(t, body.Repos, 1)
		return body.Repos[0]
	}
	connected := read()
	require.Contains(t, connected, "disconnected_at")
	require.Nil(t, connected["disconnected_at"])
	_, err := f.Pool.Exec(t.Context(), `UPDATE repo SET disconnected_at='2026-09-08T10:00:00Z',synced_at='2026-09-07T10:00:00Z' WHERE id=$1`, pr.RepoID)
	require.NoError(t, err)
	disconnected := read()
	require.Equal(t, connected["id"], disconnected["id"])
	at, err := time.Parse(time.RFC3339, disconnected["disconnected_at"].(string))
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC), at.UTC())
	var retained int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request WHERE id=$1`, pr.ID).Scan(&retained))
	require.Equal(t, 1, retained)
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

// Reinstalling a GitHub App issues a new installation id. Re-connecting the
// repository has to adopt it: keeping the dead id means every token mint fails
// and pull requests silently stop syncing, months after anyone touched setup.
func TestReconnectingARepoAdoptsTheNewInstallation(t *testing.T) {
	f := testutil.NewFixture(t)

	link := func(installationID int64) {
		_, err := f.Store.LinkRepo(t.Context(), store.LinkRepoInput{WorkspaceID: f.WorkspaceID, InstallationID: installationID, GitHubID: 9001, Owner: "acme", Name: "widgets", DefaultBranch: "main"})
		require.NoError(t, err)
	}

	link(111)
	link(222)

	var installationID int64
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT installation_id FROM repo WHERE github_id = 9001`).Scan(&installationID))
	require.Equal(t, int64(222), installationID,
		"a re-connect must adopt the new installation id, not keep the stale one")

	var repos int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM repo WHERE github_id = 9001`).Scan(&repos))
	require.Equal(t, 1, repos, "re-connecting must update the row rather than duplicate it")
}

func TestConnectingARepoCannotMoveItFromAnotherWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	var foreignWorkspaceID string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Foreign', 'foreign') RETURNING id`).
		Scan(&foreignWorkspaceID))
	_, err := f.Store.LinkRepo(t.Context(), store.LinkRepoInput{
		WorkspaceID:    uuid.MustParse(foreignWorkspaceID),
		InstallationID: 111,
		GitHubID:       9001,
		Owner:          "foreign",
		Name:           "private",
	})
	require.NoError(t, err)

	_, err = f.Store.LinkRepo(t.Context(), store.LinkRepoInput{WorkspaceID: f.WorkspaceID, InstallationID: 222, GitHubID: 9001, Owner: "acme", Name: "widgets"})
	require.ErrorIs(t, err, store.ErrForeignReference)

	var workspaceID string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT workspace_id FROM repo WHERE github_id = 9001`).Scan(&workspaceID))
	require.Equal(t, foreignWorkspaceID, workspaceID)
}

func TestManualRepositoryConnectionRouteIsGone(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/repos", map[string]any{"github_id": 9001, "owner": "acme", "name": "widgets", "installation_id": 222})
	require.Equal(t, http.StatusNotFound, rec.Code)
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM repo)+(SELECT count(*) FROM github_installation)`).Scan(&count))
	require.Zero(t, count)
}
