package worker_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/typesafe"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

// jevStub answers every System One request with the scripted choice and
// records the requests it saw, so a test can assert on what left the server.
type jevStub struct {
	mu       sync.Mutex
	choice   string
	p        float64
	status   int
	requests []map[string]any
}

func newJevStub(t *testing.T, choice string, p float64) (*jevStub, *typesafe.Client) {
	t.Helper()
	stub := &jevStub{choice: choice, p: p, status: http.StatusOK}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		stub.mu.Lock()
		stub.requests = append(stub.requests, body)
		choice, p, status := stub.choice, stub.p, stub.status
		stub.mu.Unlock()
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "jev-test",
			"answers": map[string]any{"issue": map[string]any{
				"type": "choice", "choice": choice, "confidence": p,
				"probabilities": map[string]float64{choice: p},
			}},
			"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
		})
	}))
	t.Cleanup(srv.Close)
	return stub, typesafe.New("test-key", srv.URL, "")
}

func (s *jevStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func suggestedIssue(t *testing.T, f *testutil.Fixture, column string, id uuid.UUID) *uuid.UUID {
	t.Helper()
	var issueID *uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT issue_id FROM link_suggestion WHERE `+column+` = $1`, id).Scan(&issueID))
	return issueID
}

func TestUnlinkedPRGetsASuggestionAndNoLink(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Cache the workspace lookup")
	pr := testutil.InsertPullRequest(t, f, 7, "Stop re-resolving workspaces", "open")
	stub, client := newJevStub(t, issue.Key, 0.9)
	w := worker.New(f.Store, nil).WithSuggester(client)

	n, err := w.SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, &issue.ID, suggestedIssue(t, f, "pull_request_id", pr.ID))

	// The suggestion is only a suggestion.
	var links int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&links))
	require.Zero(t, links)

	// The request carried the work and the candidate issue, keyed by issue key.
	req := stub.requests[0]
	state := req["state"].(map[string]any)
	require.Equal(t, "Stop re-resolving workspaces", state["work"].(map[string]any)["title"])
	criteria := req["questions"].(map[string]any)["issue"].(map[string]any)["criteria"].(map[string]any)
	require.Contains(t, criteria, issue.Key)
	require.Contains(t, criteria, "none_of_these")

	// Unchanged work is not sent again.
	n, err = w.SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Zero(t, n)
	require.Equal(t, 1, stub.count())
}

func TestLowProbabilityAndNoneRecordNoSuggestion(t *testing.T) {
	for _, tc := range []struct {
		name   string
		choice func(store.Issue) string
		p      float64
	}{
		{"below threshold", func(i store.Issue) string { return i.Key }, worker.MinSuggestionProbability - 0.01},
		{"none of these", func(store.Issue) string { return "none_of_these" }, 0.95},
		{"unknown key", func(store.Issue) string { return "ENG-999" }, 0.95},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := testutil.NewFixture(t)
			issue := testutil.CreateIssue(t, f, "Fix auth")
			pr := testutil.InsertPullRequest(t, f, 8, "Refactor billing", "open")
			_, client := newJevStub(t, tc.choice(issue), tc.p)

			_, err := worker.New(f.Store, nil).WithSuggester(client).SuggestOnce(t.Context())
			require.NoError(t, err)
			require.Nil(t, suggestedIssue(t, f, "pull_request_id", pr.ID))
		})
	}
}

func TestSuggestionsSkipLinkedWorkAndDisabledOrganisations(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 9, "Fix auth", "open")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))
	stub, client := newJevStub(t, issue.Key, 0.9)
	w := worker.New(f.Store, nil).WithSuggester(client)

	n, err := w.SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Zero(t, n, "linked work needs no suggestion")

	testutil.InsertPullRequest(t, f, 10, "Another", "open")
	require.NoError(t, f.Store.SetJevSuggestions(t.Context(), f.WorkspaceID, f.User.ID, false))
	n, err = w.SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Zero(t, n, "an organisation that turned suggestions off sends nothing")
	require.Zero(t, stub.count())
}

func TestWithoutAKeyNothingIsSent(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	testutil.InsertPullRequest(t, f, 11, "Fix auth", "open")

	n, err := worker.New(f.Store, nil).WithSuggester(typesafe.New("", "", "")).SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Zero(t, n)
}

func TestProjectNoteGetsASuggestionAndAcceptingFilesIt(t *testing.T) {
	f := testutil.NewFixture(t)
	project, err := f.Store.CreateProject(t.Context(), store.CreateProjectInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "velvet", Name: "Velvet"})
	require.NoError(t, err)
	issue := testutil.CreateIssue(t, f, "Cache the workspace lookup")
	note, err := f.Store.CreateComment(t.Context(), store.CreateCommentInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "project", TargetID: project.ID,
		Body: "Cached the resolved workspace so the CLI stops re-resolving.", Source: "agent"})
	require.NoError(t, err)
	_, err = f.Store.CreateComment(t.Context(), store.CreateCommentInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "project", TargetID: project.ID,
		ParentID: &note.ID, Body: "Reply stays with its note."})
	require.NoError(t, err)

	stub, client := newJevStub(t, issue.Key, 0.85)
	n, err := worker.New(f.Store, nil).WithSuggester(client).SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Equal(t, 1, n, "only the top-level note is asked about")
	work := stub.requests[0]["state"].(map[string]any)["work"].(map[string]any)
	require.Equal(t, "a coding agent", work["written_by"])
	require.Equal(t, "velvet", work["project"].(map[string]any)["key"])

	notes, err := f.Store.SuggestedNotes(t.Context(), f.WorkspaceID, 10)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.Equal(t, issue.Key, notes[0].Suggestion.IssueKey)

	key, err := f.Store.AcceptSuggestion(t.Context(), f.WorkspaceID, notes[0].Suggestion.ID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, issue.Key, key)

	comments, err := f.Store.ListComments(t.Context(), f.WorkspaceID, "issue", issue.ID)
	require.NoError(t, err)
	require.Len(t, comments, 1)
	require.Equal(t, note.ID, comments[0].ID)
	require.Equal(t, "agent", comments[0].Source, "filing keeps who wrote it")
	require.Len(t, comments[0].Replies, 1)

	var status string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT status::text FROM issue WHERE id = $1`, issue.ID).Scan(&status))
	require.Equal(t, "backlog", status, "accepting a suggestion never changes status")

	notes, err = f.Store.SuggestedNotes(t.Context(), f.WorkspaceID, 10)
	require.NoError(t, err)
	require.Empty(t, notes)
}

func TestAcceptingAPRSuggestionLinksItAsSuggested(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 12, "Harden login", "open")
	_, client := newJevStub(t, issue.Key, 0.9)
	_, err := worker.New(f.Store, nil).WithSuggester(client).SuggestOnce(t.Context())
	require.NoError(t, err)

	suggestions, err := f.Store.PullRequestSuggestions(t.Context(), f.WorkspaceID, []uuid.UUID{pr.ID})
	require.NoError(t, err)
	sg := suggestions[pr.ID]
	_, err = f.Store.AcceptSuggestion(t.Context(), f.WorkspaceID, sg.ID, f.User.ID)
	require.NoError(t, err)

	var source string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT link_source::text FROM pr_link WHERE pull_request_id = $1 AND issue_id = $2`, pr.ID, issue.ID).Scan(&source))
	require.Equal(t, "suggested", source)

	_, err = f.Store.AcceptSuggestion(t.Context(), f.WorkspaceID, sg.ID, f.User.ID)
	require.ErrorIs(t, err, store.ErrSuggestionClosed)
}

func TestDismissalSurvivesAReaskOnTheSameIssue(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 13, "Harden login", "open")
	stub, client := newJevStub(t, issue.Key, 0.9)
	w := worker.New(f.Store, nil).WithSuggester(client)
	_, err := w.SuggestOnce(t.Context())
	require.NoError(t, err)

	suggestions, err := f.Store.PullRequestSuggestions(t.Context(), f.WorkspaceID, []uuid.UUID{pr.ID})
	require.NoError(t, err)
	require.NoError(t, f.Store.DismissSuggestion(t.Context(), f.WorkspaceID, suggestions[pr.ID].ID, f.User.ID))

	// The PR's description changes, so Jev is asked again and picks the same issue.
	_, err = f.Pool.Exec(t.Context(), `UPDATE pull_request SET body = 'More detail' WHERE id = $1`, pr.ID)
	require.NoError(t, err)
	_, err = w.SuggestOnce(t.Context())
	require.NoError(t, err)
	require.Equal(t, 2, stub.count())

	suggestions, err = f.Store.PullRequestSuggestions(t.Context(), f.WorkspaceID, []uuid.UUID{pr.ID})
	require.NoError(t, err)
	require.Empty(t, suggestions, "a person is not shown a suggestion they already turned down")
}

func TestEvaluationReplaysBranchLinksWithoutWriting(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 15, "Harden login", "open")
	_, err := f.Pool.Exec(t.Context(), `UPDATE pull_request SET head_ref = 'sabari/eng-1-fix-auth' WHERE id = $1`, pr.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO pr_link (workspace_id, pull_request_id, issue_id, link_source) VALUES ($1, $2, $3, 'branch')`,
		f.WorkspaceID, pr.ID, issue.ID)
	require.NoError(t, err)
	stub, client := newJevStub(t, issue.Key, 0.92)

	var out strings.Builder
	require.NoError(t, worker.EvaluateSuggestions(t.Context(), f.Store, client, 10, &out))
	require.Contains(t, out.String(), "Replayed 1 of 1")
	require.Regexp(t, `0\.60\s+1\s+1\s+100%`, out.String())

	work := stub.requests[0]["state"].(map[string]any)["work"].(map[string]any)
	require.NotContains(t, work, "branch", "the branch names the answer, so it is hidden")

	var rows int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM link_suggestion`).Scan(&rows))
	require.Zero(t, rows, "evaluation never writes")
}

func TestUnauthorizedKeyIsAnErrorAndRetryableFailuresSaveNothing(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	pr := testutil.InsertPullRequest(t, f, 14, "Harden login", "open")
	stub, client := newJevStub(t, "", 0)
	w := worker.New(f.Store, nil).WithSuggester(client)

	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, 529} {
		stub.status = status
		_, err := w.SuggestOnce(t.Context())
		require.Error(t, err)
		var rows int
		require.NoError(t, f.Pool.QueryRow(t.Context(),
			`SELECT count(*) FROM link_suggestion WHERE pull_request_id = $1`, pr.ID).Scan(&rows))
		require.Zero(t, rows, "a failed call must be retried later, not recorded as no match")
	}
}
