package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// scopedSetup gives a test two projects in the fixture organisation and a
// second organisation the person also belongs to, then runs the real
// `velvet init` flow to mint a key bound to the first project.
type scopedSetup struct {
	f                    *testutil.Fixture
	key                  string
	ownProject, other    uuid.UUID
	ownIssue, otherIssue store.Issue
	unfiledIssue         store.Issue
	foreignSlug          string
}

func cliDo(f *testutil.Fixture, method, path string, body any) *httptest.ResponseRecorder {
	f.T.Helper()
	raw, err := json.Marshal(body)
	require.NoError(f.T, err)
	req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// approveInit runs the device flow end to end and returns the scoped key.
func approveInit(t *testing.T, f *testutil.Fixture, slug, project string) string {
	t.Helper()
	start := cliDo(f, http.MethodPost, "/api/v1/cli/sessions", map[string]string{"client_name": "test cli"})
	require.Equal(t, http.StatusCreated, start.Code, start.Body.String())
	var session struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	f.DecodeInto(start, &session)

	poll := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusAccepted, poll.Code, "pending before approval")

	approve := f.Do(http.MethodPost, "/api/v1/cli/sessions/"+session.UserCode+"/approve",
		map[string]string{"workspace_slug": slug, "project_key": project})
	require.Equal(t, http.StatusNoContent, approve.Code, approve.Body.String())

	collect := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusOK, collect.Code, collect.Body.String())
	var grant store.CLIGrant
	f.DecodeInto(collect, &grant)
	require.True(t, strings.HasPrefix(grant.Token, "velvet_"))
	require.Equal(t, slug, grant.WorkspaceSlug)

	again := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusGone, again.Code, "a grant is collected exactly once")
	return grant.Token
}

func newScopedSetup(t *testing.T) scopedSetup {
	t.Helper()
	f := testutil.NewFixture(t)
	ctx := t.Context()
	own, err := f.Store.CreateProject(ctx, store.CreateProjectInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "own", Name: "Own"})
	require.NoError(t, err)
	other, err := f.Store.CreateProject(ctx, store.CreateProjectInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "other", Name: "Other"})
	require.NoError(t, err)
	mk := func(title string, project *uuid.UUID) store.Issue {
		issue, err := f.Store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Title: title, ProjectID: project})
		require.NoError(t, err)
		return issue
	}
	s := scopedSetup{
		f: f, ownProject: own.ID, other: other.ID,
		ownIssue: mk("Own work", &own.ID), otherIssue: mk("Other work", &other.ID), unfiledIssue: mk("Unfiled", nil),
	}
	testutil.CreateForeignProject(t, f, "abroad")
	s.foreignSlug = "foreign-projects"
	s.key = approveInit(t, f, f.Slug, "own")
	return s
}

func (s scopedSetup) as(method, path string, body any) *httptest.ResponseRecorder {
	return s.f.DoAsAgent(method, path, s.key, body)
}

func setRole(t *testing.T, f *testutil.Fixture, role string) {
	t.Helper()
	_, err := f.Pool.Exec(t.Context(), `UPDATE membership SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, f.WorkspaceID, f.User.ID, role)
	require.NoError(t, err)
}

func TestScopedKeyWorksInsideItsProject(t *testing.T) {
	s := newScopedSetup(t)
	base := "/api/v1/w/lab"

	rec := s.as(http.MethodGet, "/api/v1/me", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"project_key":"own"`)
	require.NotContains(t, rec.Body.String(), "foreign-projects", "other memberships stay private")

	rec = s.as(http.MethodGet, base+"/issues", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), s.ownIssue.Key)
	require.NotContains(t, rec.Body.String(), s.otherIssue.Key, "listing is pinned to the key's project")
	require.NotContains(t, rec.Body.String(), s.unfiledIssue.Key, "unfiled tickets are outside every project key")

	for _, ok := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, base + "/issues/" + s.ownIssue.Key, nil},
		{http.MethodPost, base + "/issues/" + s.ownIssue.Key + "/comments", map[string]string{"body": "Did the work.", "kind": "progress"}},
		{http.MethodPatch, base + "/issues/" + s.ownIssue.Key, map[string]string{"status": "in_progress"}},
		{http.MethodPost, base + "/projects/own/comments", map[string]string{"body": "Project note.", "kind": "note"}},
		{http.MethodGet, base + "/sprints", nil},
		{http.MethodGet, base + "/milestones", nil},
		{http.MethodGet, "/api/v1/me/worklog?days=7", nil},
	} {
		rec := s.as(ok.method, ok.path, ok.body)
		require.Less(t, rec.Code, 300, "%s %s: %s", ok.method, ok.path, rec.Body.String())
	}

	rec = s.as(http.MethodPost, base+"/issues", map[string]string{"title": "Filed by the agent"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created store.Issue
	s.f.DecodeInto(rec, &created)
	require.NotNil(t, created.ProjectID)
	require.Equal(t, s.ownProject, *created.ProjectID, "a new ticket lands in the key's project")

	rec = s.as(http.MethodPost, base+"/sprints", map[string]string{"name": "Agent sprint", "starts_on": "2026-11-01", "ends_on": "2026-11-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), s.ownProject.String())

	// Work written through the key is attributed as agent work.
	var source string
	require.NoError(t, s.f.Pool.QueryRow(t.Context(),
		`SELECT source FROM comment WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`, s.ownIssue.ID).Scan(&source))
	require.Equal(t, "agent", source)
}

func TestScopedIssueDetailFiltersChildrenByProject(t *testing.T) {
	s := newScopedSetup(t)
	children := make([]store.Issue, 0, 3)
	for _, project := range []*uuid.UUID{&s.ownProject, &s.other, nil} {
		child, err := s.f.Store.CreateIssue(t.Context(), store.CreateIssueInput{
			WorkspaceID: s.f.WorkspaceID, ActorID: s.f.User.ID,
			Title: "Child", Description: "Private child description",
			ProjectID: project, ParentID: &s.ownIssue.ID,
		})
		require.NoError(t, err)
		children = append(children, child)
	}
	path := "/api/v1/w/lab/issues/" + s.ownIssue.Key
	personal := s.f.AgentToken("personal")
	for _, caller := range []struct {
		name  string
		token string
		want  int
	}{
		{"scoped", s.key, 1},
		{"personal", personal, 3},
		{"browser", "", 3},
	} {
		t.Run(caller.name, func(t *testing.T) {
			var rec *httptest.ResponseRecorder
			if caller.token == "" {
				rec = s.f.Do(http.MethodGet, path, nil)
			} else {
				rec = s.f.DoAsAgent(http.MethodGet, path, caller.token, nil)
			}
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var got store.Issue
			s.f.DecodeInto(rec, &got)
			require.Len(t, got.Children, caller.want)
			if caller.name == "scoped" {
				require.Equal(t, children[0].ID, got.Children[0].ID)
				for _, hidden := range children[1:] {
					require.NotContains(t, rec.Body.String(), hidden.ID.String())
					require.NotContains(t, rec.Body.String(), hidden.Key)
				}
			}
		})
	}
}

func TestScopedKeyCannotLeaveItsProject(t *testing.T) {
	s := newScopedSetup(t)
	base := "/api/v1/w/lab"

	denied := []struct {
		name         string
		method, path string
		body         any
		want         int
	}{
		{"another project's ticket", http.MethodGet, base + "/issues/" + s.otherIssue.Key, nil, http.StatusForbidden},
		{"an unfiled ticket", http.MethodGet, base + "/issues/" + s.unfiledIssue.Key, nil, http.StatusForbidden},
		{"log on another project's ticket", http.MethodPost, base + "/issues/" + s.otherIssue.Key + "/comments", map[string]string{"body": "x"}, http.StatusForbidden},
		{"another project's notes", http.MethodPost, base + "/projects/other/comments", map[string]string{"body": "x"}, http.StatusForbidden},
		{"list another project", http.MethodGet, base + "/issues?project=other", nil, http.StatusForbidden},
		{"file into another project", http.MethodPost, base + "/issues", map[string]string{"title": "x", "project": "other"}, http.StatusForbidden},
		{"move own ticket out", http.MethodPatch, base + "/issues/" + s.ownIssue.Key, map[string]string{"project": "other"}, http.StatusForbidden},
		{"unfile own ticket", http.MethodPatch, base + "/issues/" + s.ownIssue.Key, map[string]any{"project_id": nil}, http.StatusForbidden},
		{"sprint in another project", http.MethodPost, base + "/sprints", map[string]string{"name": "x", "starts_on": "2026-11-01", "ends_on": "2026-11-30", "project": "other"}, http.StatusForbidden},
		{"recap another project", http.MethodGet, "/api/v1/me/worklog?project=other", nil, http.StatusForbidden},
		{"recap another organisation", http.MethodGet, "/api/v1/me/worklog?workspace=" + s.foreignSlug, nil, http.StatusForbidden},
		{"another organisation", http.MethodGet, "/api/v1/w/" + s.foreignSlug + "/issues", nil, http.StatusNotFound},
		{"members", http.MethodGet, base + "/members", nil, http.StatusForbidden},
		{"admin: rename organisation", http.MethodPatch, base, map[string]string{"name": "Hijacked"}, http.StatusForbidden},
		{"create a project", http.MethodPost, base + "/projects", map[string]string{"key": "new", "name": "New"}, http.StatusForbidden},
		{"list projects", http.MethodGet, base + "/projects", nil, http.StatusForbidden},
		{"activity feed", http.MethodGet, base + "/activity", nil, http.StatusForbidden},
		{"reports other project", http.MethodGet, base + "/reports/stale?project=other", nil, http.StatusForbidden},
		{"mint more keys", http.MethodPost, "/api/v1/me/tokens", map[string]string{"name": "escape"}, http.StatusForbidden},
		{"list keys", http.MethodGet, "/api/v1/me/tokens", nil, http.StatusForbidden},
		{"approve its own sign-in", http.MethodPost, "/api/v1/cli/sessions/ABCD-EFGH/approve", map[string]string{"workspace_slug": "lab", "project_key": "other"}, http.StatusForbidden},
		{"resolve other repos", http.MethodPost, "/api/v1/me/resolve-repo", map[string]string{"remote": "git@github.com:x/y.git"}, http.StatusForbidden},
		{"create an organisation", http.MethodPost, "/api/v1/orgs", map[string]string{"name": "x", "slug": "xyz", "issue_prefix": "XY"}, http.StatusForbidden},
	}
	for _, d := range denied {
		t.Run(d.name, func(t *testing.T) {
			rec := s.as(d.method, d.path, d.body)
			require.Equal(t, d.want, rec.Code, rec.Body.String())
		})
	}

	// Nothing above changed the world.
	var name string
	require.NoError(t, s.f.Pool.QueryRow(t.Context(), `SELECT name FROM workspace WHERE id = $1`, s.f.WorkspaceID).Scan(&name))
	require.NotEqual(t, "Hijacked", name)
	var count int
	require.NoError(t, s.f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM comment WHERE target_id = $1`, s.otherIssue.ID).Scan(&count))
	require.Zero(t, count)
}

// A personal key, created in the browser, keeps its full reach. Scoping
// applies only to keys minted by `velvet init`.
func TestPersonalKeyIsUnaffectedByScoping(t *testing.T) {
	s := newScopedSetup(t)
	personal := s.f.AgentToken("personal")
	rec := s.f.DoAsAgent(http.MethodGet, "/api/v1/w/lab/issues/"+s.otherIssue.Key, personal, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	rec = s.f.DoAsAgent(http.MethodGet, "/api/v1/w/lab/members", personal, nil)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestScopedKeyRevokesItself(t *testing.T) {
	s := newScopedSetup(t)
	require.Equal(t, http.StatusNoContent, s.as(http.MethodDelete, "/api/v1/me/token", nil).Code)
	require.Equal(t, http.StatusUnauthorized, s.as(http.MethodGet, "/api/v1/me", nil).Code)
}

func TestCLISignInRefusals(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Store.CreateProject(t.Context(), store.CreateProjectInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "own", Name: "Own"})
	require.NoError(t, err)

	start := func() (string, string) {
		rec := cliDo(f, http.MethodPost, "/api/v1/cli/sessions", map[string]string{})
		require.Equal(t, http.StatusCreated, rec.Code)
		var s struct{ DeviceCode, UserCode string }
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &struct {
			D *string `json:"device_code"`
			U *string `json:"user_code"`
		}{&s.DeviceCode, &s.UserCode}))
		return s.DeviceCode, s.UserCode
	}
	poll := func(device string) int {
		return cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": device}).Code
	}

	t.Run("denied", func(t *testing.T) {
		device, code := start()
		require.Equal(t, http.StatusNoContent, f.Do(http.MethodPost, "/api/v1/cli/sessions/"+code+"/deny", map[string]string{}).Code)
		require.Equal(t, http.StatusForbidden, poll(device))
		require.Equal(t, http.StatusNotFound,
			f.Do(http.MethodPost, "/api/v1/cli/sessions/"+code+"/approve", map[string]string{"workspace_slug": "lab", "project_key": "own"}).Code,
			"a denied code cannot be approved later")
	})

	t.Run("expired", func(t *testing.T) {
		device, code := start()
		_, err := f.Pool.Exec(t.Context(), `UPDATE cli_session SET expires_at = now() - interval '1 second' WHERE user_code = $1`, store.NormalizeUserCode(code))
		require.NoError(t, err)
		require.Equal(t, http.StatusNotFound, f.Do(http.MethodGet, "/api/v1/cli/sessions/"+code, nil).Code)
		require.Equal(t, http.StatusGone, poll(device))
	})

	t.Run("unknown device secret", func(t *testing.T) {
		require.Equal(t, http.StatusGone, poll("velvetdev_nope"))
	})

	t.Run("code is forgiving about case and hyphen", func(t *testing.T) {
		_, code := start()
		loose := strings.ToLower(strings.ReplaceAll(code, "-", "%20"))
		require.Equal(t, http.StatusOK, f.Do(http.MethodGet, "/api/v1/cli/sessions/"+loose, nil).Code)
	})

	t.Run("project from another organisation", func(t *testing.T) {
		testutil.CreateForeignProject(t, f, "abroad")
		_, code := start()
		rec := f.Do(http.MethodPost, "/api/v1/cli/sessions/"+code+"/approve", map[string]string{"workspace_slug": "lab", "project_key": "abroad"})
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("viewer cannot approve", func(t *testing.T) {
		setRole(t, f, "viewer")
		defer setRole(t, f, "admin")
		_, code := start()
		rec := f.Do(http.MethodPost, "/api/v1/cli/sessions/"+code+"/approve", map[string]string{"workspace_slug": "lab", "project_key": "own"})
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("approval needs a browser session", func(t *testing.T) {
		_, code := start()
		key := f.AgentToken("not a browser")
		rec := f.DoAsAgent(http.MethodPost, "/api/v1/cli/sessions/"+code+"/approve", key, map[string]string{"workspace_slug": "lab", "project_key": "own"})
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("removed member's approval is not honoured", func(t *testing.T) {
		device, code := start()
		require.Equal(t, http.StatusNoContent,
			f.Do(http.MethodPost, "/api/v1/cli/sessions/"+code+"/approve", map[string]string{"workspace_slug": "lab", "project_key": "own"}).Code)
		setRole(t, f, "viewer")
		defer setRole(t, f, "admin")
		require.Equal(t, http.StatusForbidden, poll(device))
		require.Equal(t, http.StatusForbidden, poll(device), "the refusal sticks")
		var keys int
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM api_token WHERE project_id IS NOT NULL`).Scan(&keys))
		require.Zero(t, keys, "no key was minted")
	})
}
