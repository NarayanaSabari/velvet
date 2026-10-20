package api_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// suggest stores a suggestion directly, standing in for the worker's call to
// Jev. These tests are about what people can do with a suggestion.
func suggest(t *testing.T, f *testutil.Fixture, kind string, subject, issue uuid.UUID) uuid.UUID {
	t.Helper()
	p := 0.9
	require.NoError(t, f.Store.SaveSuggestion(t.Context(), store.SaveSuggestionInput{
		Kind: kind, SubjectID: subject, WorkspaceID: f.WorkspaceID,
		IssueID: &issue, Probability: &p, Model: "jev-test", Fingerprint: "fp"}))
	column := "pull_request_id"
	if kind == store.SuggestionNote {
		column = "comment_id"
	}
	var id uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM link_suggestion WHERE `+column+` = $1`, subject).Scan(&id))
	return id
}

func TestUnlinkedPRsCarryTheirSuggestion(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 42, "Harden login", "open")
	suggest(t, f, store.SuggestionPullRequest, pr.ID, issue.ID)

	var body struct {
		PullRequests []struct {
			ID         uuid.UUID             `json:"id"`
			Suggestion *store.LinkSuggestion `json:"suggestion"`
		} `json:"pull_requests"`
	}
	rec := f.Do(http.MethodGet, "/api/v1/w/lab/pull-requests/unlinked", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	f.DecodeInto(rec, &body)
	require.Len(t, body.PullRequests, 1)
	require.NotNil(t, body.PullRequests[0].Suggestion)
	require.Equal(t, issue.Key, body.PullRequests[0].Suggestion.IssueKey)
	require.InDelta(t, 0.9, body.PullRequests[0].Suggestion.Probability, 1e-6)

	// Turning suggestions off hides them at once.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/suggestions/settings", map[string]any{"enabled": false})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/pull-requests/unlinked", nil)
	f.DecodeInto(rec, &body)
	require.Nil(t, body.PullRequests[0].Suggestion)
}

func TestAcceptingThroughTheAPILinksAndAnnounces(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 42, "Harden login", "open")
	id := suggest(t, f, store.SuggestionPullRequest, pr.ID, issue.ID)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/accept", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), issue.Key)

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, issue.ID).Scan(&verb))
	require.Equal(t, store.VerbAttachedPR, verb)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/accept", nil)
	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestSuggestionsOfAnotherWorkspaceCannotBeUsed(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	foreignPR := testutil.InsertForeignPullRequest(t, f, 7, "Elsewhere")

	var foreignWS uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT workspace_id FROM pull_request WHERE id = $1`, foreignPR).Scan(&foreignWS))
	var id uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		INSERT INTO link_suggestion (workspace_id, pull_request_id, issue_id, probability, fingerprint)
		VALUES ($1, $2, $3, 0.9, 'fp') RETURNING id`, foreignWS, foreignPR, issue.ID).Scan(&id))

	for _, action := range []string{"accept", "dismiss"} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/"+action, nil)
		require.Equal(t, http.StatusNotFound, rec.Code, action)
	}
}

func TestViewersCannotActOnSuggestionsOrChangeTheSetting(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 42, "Harden login", "open")
	id := suggest(t, f, store.SuggestionPullRequest, pr.ID, issue.ID)
	_, err := f.Pool.Exec(t.Context(), `UPDATE membership SET role = 'viewer' WHERE user_id = $1`, f.User.ID)
	require.NoError(t, err)

	require.Equal(t, http.StatusForbidden, f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/accept", nil).Code)
	require.Equal(t, http.StatusForbidden, f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/dismiss", nil).Code)
	require.Equal(t, http.StatusForbidden, f.Do(http.MethodPatch, "/api/v1/w/lab/suggestions/settings", map[string]any{"enabled": false}).Code)
	require.Equal(t, http.StatusOK, f.Do(http.MethodGet, "/api/v1/w/lab/suggestions/settings", nil).Code)
}

func TestSettingsReportWhetherTheServerCanSuggest(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodGet, "/api/v1/w/lab/suggestions/settings", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"enabled":true,"available":false}`, rec.Body.String(),
		"on by default, and honest that no key is configured")

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/suggestions/settings", map[string]any{})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSuggestedNotesListAndDismiss(t *testing.T) {
	f := testutil.NewFixture(t)
	project, err := f.Store.CreateProject(t.Context(), store.CreateProjectInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "velvet", Name: "Velvet"})
	require.NoError(t, err)
	issue := testutil.CreateIssue(t, f, "Cache the workspace lookup")
	note, err := f.Store.CreateComment(t.Context(), store.CreateCommentInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "project", TargetID: project.ID,
		Body: "Cached the workspace."})
	require.NoError(t, err)
	id := suggest(t, f, store.SuggestionNote, note.ID, issue.ID)

	var body struct {
		Notes []store.SuggestedNote `json:"notes"`
	}
	rec := f.Do(http.MethodGet, "/api/v1/w/lab/suggestions/notes", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	f.DecodeInto(rec, &body)
	require.Len(t, body.Notes, 1)
	require.Equal(t, "velvet", body.Notes[0].ProjectKey)
	require.Equal(t, issue.Key, body.Notes[0].Suggestion.IssueKey)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/suggestions/"+id.String()+"/dismiss", nil)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/suggestions/notes", nil)
	f.DecodeInto(rec, &body)
	require.Empty(t, body.Notes)

	// The note itself is untouched by a dismissal.
	comments, err := f.Store.ListComments(t.Context(), f.WorkspaceID, "project", project.ID)
	require.NoError(t, err)
	require.Len(t, comments, 1)
}
