package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func createIssue(t *testing.T, f *testutil.Fixture, body map[string]any) store.Issue {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues", body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var i store.Issue
	f.DecodeInto(rec, &i)
	return i
}

func TestIssueKeysIncrementPerWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	first := createIssue(t, f, map[string]any{"title": "First"})
	second := createIssue(t, f, map[string]any{"title": "Second"})
	require.Equal(t, "ENG-1", first.Key)
	require.Equal(t, "ENG-2", second.Key)
	require.Equal(t, "backlog", first.Status, "an issue starts in the backlog")
}

func TestIssueKeyPathsNormalizeCaseAndWhitespace(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	for _, key := range []string{"eng-1", "eNg-1", "%20eNg-1%20"} {
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+key, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

		var got store.Issue
		f.DecodeInto(rec, &got)
		require.Equal(t, issue.ID, got.ID)
		require.Equal(t, issue.Key, got.Key)
	}

	for _, key := range []string{"eng-1", "eNg-1"} {
		rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+key,
			map[string]any{"title": "Updated " + key})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

		var updated store.Issue
		f.DecodeInto(rec, &updated)
		require.Equal(t, issue.ID, updated.ID)

		rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+key+"/comments",
			map[string]any{"body": "A note for " + key})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

		var comment store.Comment
		f.DecodeInto(rec, &comment)
		require.Equal(t, issue.ID, comment.TargetID)

		rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+key+"/comments", nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var comments struct {
			Comments []store.Comment `json:"comments"`
		}
		f.DecodeInto(rec, &comments)
		require.NotEmpty(t, comments.Comments)
		require.Equal(t, issue.ID, comments.Comments[len(comments.Comments)-1].TargetID)
	}
}

func TestCreatingAnIssueRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1`, issue.ID).Scan(&verb))
	require.Equal(t, store.VerbCreatedIssue, verb)
}

func TestStatusChangeAndAssignmentEachRecordActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"status": "in_progress", "assignee_id": f.User.ID.String()})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rows, err := f.Pool.Query(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 ORDER BY id`, issue.ID)
	require.NoError(t, err)
	defer rows.Close()

	var verbs []string
	for rows.Next() {
		var v string
		require.NoError(t, rows.Scan(&v))
		verbs = append(verbs, v)
	}
	require.Equal(t,
		[]string{store.VerbCreatedIssue, store.VerbChangedStatus, store.VerbAssigned}, verbs)
}

func TestUnchangedPatchRecordsNoActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	// Re-sending the same status must not add a row: a feed full of no-ops is
	// a feed nobody reads.
	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"status": "backlog"})
	require.Equal(t, http.StatusOK, rec.Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE target_id = $1 AND verb = $2`,
		issue.ID, store.VerbChangedStatus).Scan(&count))
	require.Equal(t, 0, count)
}

func TestIssueRejectsUnknownStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues",
		map[string]any{"title": "Bad", "status": "shipping"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestIssueRejectsAssigneeFromAnotherWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	foreign, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 9999, Login: "outsider"})
	require.NoError(t, err)
	var otherWorkspace string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWorkspace))
	_, err = f.Pool.Exec(t.Context(),
		`INSERT INTO membership (workspace_id, user_id)
		 VALUES ($1, $2)`, otherWorkspace, foreign.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues", map[string]any{
		"title": "Secret assignment", "assignee_id": foreign.ID.String(),
	})
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}

func TestSubIssueNestingIsRejectedByTheAPI(t *testing.T) {
	f := testutil.NewFixture(t)
	parent := createIssue(t, f, map[string]any{"title": "Parent"})
	child := createIssue(t, f,
		map[string]any{"title": "Child", "parent_id": parent.ID.String()})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues",
		map[string]any{"title": "Grandchild", "parent_id": child.ID.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "one level")
}

func TestIssueListFiltersByStatusAndAssignee(t *testing.T) {
	f := testutil.NewFixture(t)
	createIssue(t, f, map[string]any{"title": "Untouched"})
	mine := createIssue(t, f, map[string]any{
		"title": "Mine", "assignee_id": f.User.ID.String(), "status": "in_progress"})

	rec := f.Do(http.MethodGet,
		"/api/v1/w/lab/issues?status=in_progress&assignee_id="+f.User.ID.String(), nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Issues     []store.Issue `json:"issues"`
		NextCursor string        `json:"next_cursor"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Issues, 1)
	require.Equal(t, mine.Key, list.Issues[0].Key)
}

func TestIssueOfAnotherWorkspaceIsNotReachable(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO issue (workspace_id, key, number, title, position)
		VALUES ($1, 'ENG-1', 1, 'Secret', 'V')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/ENG-1", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
