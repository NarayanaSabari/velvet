package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func recap(t *testing.T, f *testutil.Fixture, query string) []store.WorklogEntry {
	t.Helper()
	rec := f.Do(http.MethodGet, "/api/v1/me/worklog"+query, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Entries []store.WorklogEntry `json:"entries"`
	}
	f.DecodeInto(rec, &body)
	return body.Entries
}

func kindsIn(entries []store.WorklogEntry) map[string]int {
	counts := map[string]int{}
	for _, e := range entries {
		counts[e.Kind]++
	}
	return counts
}

// The question this exists to answer: what was I working on, across every
// organisation, without having to remember which one.
func TestRecapGathersWorkFromEveryOrganisation(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))

	// Home organisation: a ticket and a note against a project.
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	issue := createIssue(t, f, map[string]any{
		"title": "Ship the recap", "project": "velvet", "assignee_id": f.User.ID.String()})
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
		map[string]any{"body": "I built the cross-organisation recap.", "kind": "progress"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// Client organisation: a pull request and a commit under the other account.
	clientProject, err := f.Store.CreateProject(ctx, store.CreateProjectInput{
		WorkspaceID: clientWS, ActorID: f.User.ID, Key: "client-app", Name: "Client app"})
	require.NoError(t, err)
	repo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: clientWS, InstallationID: 99, GitHubID: 777,
		Owner: "client", Name: "app"})
	require.NoError(t, err)
	require.NoError(t, f.Store.SetRepoProject(ctx, clientWS, repo.ID, f.User.ID, &clientProject.ID))

	insertPR(t, f, clientWS, repo.ID, 1, "sabari-client")
	require.NoError(t, f.Store.UpsertCommit(ctx, store.UpsertCommitInput{
		SHA: "1111111111111111111111111111111111111111", WorkspaceID: clientWS,
		RepoID: repo.ID, Branch: "main", Message: "Client commit",
		AuthorLogin: "sabari-client", CommittedAt: time.Now().UTC()}))

	entries := recap(t, f, "")
	counts := kindsIn(entries)
	require.NotZero(t, counts["note"], "the notes I wrote")
	require.NotZero(t, counts["issue"], "the tickets I worked")
	require.NotZero(t, counts["pull_request"], "the pull requests that prove it")
	require.NotZero(t, counts["commit"], "the commits that prove it")

	slugs := map[string]bool{}
	for _, e := range entries {
		slugs[e.WorkspaceSlug] = true
	}
	require.True(t, slugs["lab"], "work in the home organisation")
	require.True(t, slugs["client"], "work in the client organisation")

	// Entries carry the project they belong to, so a week reads as projects
	// rather than as a flat list.
	projects := map[string]bool{}
	for _, e := range entries {
		if e.ProjectKey != nil {
			projects[*e.ProjectKey] = true
		}
	}
	require.True(t, projects["velvet"])
	require.True(t, projects["client-app"])

	// Newest first, the order a person reads their own week in.
	for i := 1; i < len(entries); i++ {
		require.GreaterOrEqual(t, entries[i-1].At, entries[i].At)
	}
	require.NotEmpty(t, issue.Key)
}

// A recap must never leak another person's work, which is the one thing that
// would make it unusable for reporting to a manager.
func TestRecapNeverShowsAnotherPersonsWork(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	colleague, err := testutil.CreateLinkedUser(t, f.Store,
		store.GitHubIdentity{ID: 3003, Login: "colleague"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
		f.WorkspaceID, colleague.ID)
	require.NoError(t, err)

	theirIssue, err := f.Store.CreateIssue(ctx, store.CreateIssueInput{
		WorkspaceID: f.WorkspaceID, ActorID: colleague.ID,
		Title: "Their work", AssigneeID: &colleague.ID})
	require.NoError(t, err)
	_, err = f.Store.CreateComment(ctx, store.CreateCommentInput{
		WorkspaceID: f.WorkspaceID, ActorID: colleague.ID,
		TargetType: "issue", TargetID: theirIssue.ID, Body: "Their note"})
	require.NoError(t, err)

	for _, e := range recap(t, f, "") {
		require.NotEqual(t, "Their work", e.Title)
		require.NotContains(t, e.Body, "Their note")
	}
}

// Leaving an organisation ends access to its record, including in the recap.
func TestRecapExcludesOrganisationsTheCallerHasLeft(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	_, err := f.Store.CreateIssue(ctx, store.CreateIssueInput{
		WorkspaceID: clientWS, ActorID: f.User.ID, Title: "Client ticket"})
	require.NoError(t, err)
	require.NotEmpty(t, recap(t, f, "?workspace=client"))

	_, err = f.Pool.Exec(ctx,
		`DELETE FROM membership WHERE workspace_id = $1 AND user_id = $2`, clientWS, f.User.ID)
	require.NoError(t, err)

	for _, e := range recap(t, f, "") {
		require.NotEqual(t, "client", e.WorkspaceSlug,
			"work in an organisation I left must not appear")
	}
}

func TestRecapFiltersByWindowOrganisationAndProject(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	createProject(t, f, map[string]any{"key": "other", "name": "Other"})
	createIssue(t, f, map[string]any{
		"title": "Recent", "project": "velvet", "assignee_id": f.User.ID.String()})
	old, err := f.Store.CreateIssue(ctx, store.CreateIssueInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID,
		Title: "Ancient", AssigneeID: &f.User.ID})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`UPDATE issue SET updated_at = now() - interval '60 days' WHERE id = $1`, old.ID)
	require.NoError(t, err)

	titles := func(entries []store.WorklogEntry) map[string]bool {
		out := map[string]bool{}
		for _, e := range entries {
			out[e.Title] = true
		}
		return out
	}

	// The default window is the past week, so old work is out of view until
	// the question explicitly asks for it.
	within := titles(recap(t, f, ""))
	require.True(t, within["Recent"])
	require.False(t, within["Ancient"], "the default window is the past week")

	wider := titles(recap(t, f, "?days=90"))
	require.True(t, wider["Ancient"], "a wider window finds older work")

	require.True(t, titles(recap(t, f, "?project=velvet"))["Recent"])
	require.False(t, titles(recap(t, f, "?project=other"))["Recent"])
	require.True(t, titles(recap(t, f, "?workspace=lab"))["Recent"])
	require.Empty(t, recap(t, f, "?workspace=nonexistent"))
}

func TestRecapRejectsMalformedWindows(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, query := range []string{
		"?from=not-a-date", "?to=13-13-13", "?days=0", "?days=x", "?limit=0",
		"?from=2026-02-01&to=2026-01-01",
	} {
		rec := f.Do(http.MethodGet, "/api/v1/me/worklog"+query, nil)
		require.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", query, rec.Body.String())
	}
}

// The answer has to be pasteable into a message, because that is how the
// question usually arrives.
func TestRecapRendersAsMarkdown(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
		map[string]any{"body": "I finished the recap endpoint.", "kind": "progress"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/me/worklog.md", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Header().Get("Content-Type"), "text/markdown")

	body := rec.Body.String()
	require.Contains(t, body, "# Work log")
	require.Contains(t, body, "### Lab", "grouped by organisation")
	require.Contains(t, body, "[velvet]", "the project the work belongs to")
	require.Contains(t, body, "I finished the recap endpoint.")

	// An empty period says so rather than returning a bare heading.
	rec = f.Do(http.MethodGet, "/api/v1/me/worklog.md?from=2020-01-01&to=2020-01-02", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "No recorded work in this period.")
}

// An agent asks the same question through its token, with no browser session.
func TestRecapIsReachableByAnAgentToken(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	token := f.AgentToken("coding agent")

	rec := f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments", token,
		map[string]any{"body": "Logged by the agent.", "kind": "progress"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = f.DoAsAgent(http.MethodGet, "/api/v1/me/worklog", token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Entries []store.WorklogEntry `json:"entries"`
	}
	f.DecodeInto(rec, &body)

	var found bool
	for _, e := range body.Entries {
		if e.Kind == "note" && e.Source == "agent" {
			found = true
		}
	}
	require.True(t, found, "an agent's own entries appear in the recap it can read")
}

func TestRecapCommitsFollowThePerOrganisationIdentity(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	repo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: clientWS, InstallationID: 99, GitHubID: 777,
		Owner: "client", Name: "app"})
	require.NoError(t, err)

	sha := "2222222222222222222222222222222222222222"
	require.NoError(t, f.Store.UpsertCommit(ctx, store.UpsertCommitInput{
		SHA: sha, WorkspaceID: clientWS, RepoID: repo.ID, Branch: "main",
		Message: "Client commit", AuthorLogin: "sabari-client",
		CommittedAt: time.Now().UTC()}))

	// Without the organisation's identity the commit is not recognised as
	// this person's, which is exactly the bug per-org identity exists to fix.
	var before int
	for _, e := range recap(t, f, "?workspace=client") {
		if e.Kind == "commit" {
			before++
		}
	}
	require.Zero(t, before)

	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))

	var after int
	for _, e := range recap(t, f, "?workspace=client") {
		if e.Kind == "commit" {
			after++
		}
	}
	require.Equal(t, 1, after, "linking the client account surfaces its commits")
}

func TestRecapRequiresAuthentication(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, path := range []string{"/api/v1/me/worklog", "/api/v1/me/worklog.md"} {
		rec := httptest.NewRecorder()
		f.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code, path)
	}
	require.NotEqual(t, uuid.Nil, f.User.ID)
}
