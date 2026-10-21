package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func approveLogin(t *testing.T, f *testutil.Fixture) string {
	t.Helper()
	start := cliDo(f, http.MethodPost, "/api/v1/cli/sessions", map[string]string{"client_name": "test machine", "flow": "login"})
	require.Equal(t, http.StatusCreated, start.Code, start.Body.String())
	var session struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	f.DecodeInto(start, &session)
	lookup := f.Do(http.MethodGet, "/api/v1/cli/sessions/"+session.UserCode, nil)
	require.Equal(t, http.StatusOK, lookup.Code, lookup.Body.String())
	require.Contains(t, lookup.Body.String(), `"flow":"login"`)
	pending := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusAccepted, pending.Code)
	approval := f.Do(http.MethodPost, "/api/v1/cli/sessions/"+session.UserCode+"/approve", map[string]string{})
	require.Equal(t, http.StatusNoContent, approval.Code, approval.Body.String())
	poll := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusOK, poll.Code, poll.Body.String())
	var grant store.CLIGrant
	f.DecodeInto(poll, &grant)
	require.Equal(t, "setup", grant.Kind)
	require.True(t, strings.HasPrefix(grant.Token, "velvetsetup_"))
	require.Empty(t, grant.WorkspaceSlug)
	require.Empty(t, grant.ProjectKey)
	again := cliDo(f, http.MethodPost, "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusGone, again.Code)
	return grant.Token
}

func TestSetupTokenDefaultDenyAndSetupRoutes(t *testing.T) {
	f := testutil.NewFixture(t)
	key := approveLogin(t, f)
	_, setupID, _, err := f.Store.LookupAPIToken(t.Context(), key)
	require.NoError(t, err)
	var storedHash string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT token_hash FROM api_token WHERE id=$1`, setupID).Scan(&storedHash))
	require.Equal(t, store.HashToken("cli-setup:"+key), storedHash)
	require.NotEqual(t, store.HashToken(key), storedHash)
	var legacyMatches int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM api_token WHERE token_hash=$1`, store.HashToken(key)).Scan(&legacyMatches))
	require.Zero(t, legacyMatches, "old binaries must not authenticate setup tokens as personal tokens")
	me := f.DoAsAgent(http.MethodGet, "/api/v1/me", key, nil)
	require.Equal(t, http.StatusOK, me.Code)
	require.Contains(t, me.Body.String(), `"token_kind":"setup"`)
	require.Contains(t, me.Body.String(), f.Slug)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v1/me/worklog"}, {"GET", "/api/v1/me/worklog.md"},
		{"GET", "/api/v1/me/tokens"}, {"POST", "/api/v1/me/tokens"},
		{"DELETE", "/api/v1/me/tokens/" + uuid.NewString()},
		{"GET", "/api/v1/w/lab/issues"}, {"POST", "/api/v1/w/lab/issues"},
		{"GET", "/api/v1/w/lab/sprints"}, {"GET", "/api/v1/w/lab/milestones"},
		{"GET", "/api/v1/w/lab/projects/secret"}, {"GET", "/api/v1/w/lab/projects/secret/comments"},
		{"PATCH", "/api/v1/w/lab"}, {"DELETE", "/api/v1/w/lab"},
	} {
		res := f.DoAsAgent(route.method, route.path, key, map[string]string{})
		require.Equal(t, http.StatusForbidden, res.Code, "%s %s: %s", route.method, route.path, res.Body.String())
	}
	org := f.DoAsAgent(http.MethodPost, "/api/v1/orgs", key, map[string]string{"name": "Setup Org", "slug": "setup-org", "issue_prefix": "SET"})
	require.Equal(t, http.StatusCreated, org.Code, org.Body.String())
	project := f.DoAsAgent(http.MethodPost, "/api/v1/w/setup-org/projects", key, map[string]string{"name": "Setup Project", "key": "setup"})
	require.Equal(t, http.StatusCreated, project.Code, project.Body.String())
	list := f.DoAsAgent(http.MethodGet, "/api/v1/w/setup-org/projects", key, nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	require.Contains(t, list.Body.String(), "Setup Project")
	foreign := f.DoAsAgent(http.MethodGet, "/api/v1/w/no-membership/projects", key, nil)
	require.Equal(t, http.StatusNotFound, foreign.Code)
}

func TestSetupProjectIssuanceRotationIsolationAndCascade(t *testing.T) {
	s := newScopedSetup(t)
	f := s.f
	key := approveLogin(t, f)
	issue := func(project string) *store.CLIGrant {
		res := f.DoAsAgent(http.MethodPost, "/api/v1/cli/project-tokens", key, map[string]string{"workspace_slug": f.Slug, "project_key": project})
		require.Equal(t, http.StatusOK, res.Code, res.Body.String())
		var grant store.CLIGrant
		f.DecodeInto(res, &grant)
		require.Equal(t, "project", grant.Kind)
		require.Equal(t, f.Slug, grant.WorkspaceSlug)
		require.Equal(t, project, grant.ProjectKey)
		return &grant
	}
	first := issue("own")
	require.True(t, strings.HasPrefix(first.Token, "velvet_"))
	_, firstID, scope, err := f.Store.LookupAPIToken(t.Context(), first.Token)
	require.NoError(t, err)
	require.NotNil(t, scope.ParentID)
	require.Equal(t, s.ownProject, *scope.ProjectID)
	again := issue("own")
	require.NotEqual(t, first.Token, again.Token)
	_, againID, _, err := f.Store.LookupAPIToken(t.Context(), again.Token)
	require.NoError(t, err)
	require.Equal(t, firstID, againID, "repeat issuance reuses row and quota")
	require.Equal(t, http.StatusUnauthorized, f.DoAsAgent("GET", "/api/v1/me", first.Token, nil).Code)
	other := issue("other")
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("GET", "/api/v1/w/lab/issues/"+s.otherIssue.Key, again.Token, nil).Code)
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/w/lab/issues/"+s.ownIssue.Key, again.Token, nil).Code)
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("POST", "/api/v1/cli/project-tokens", again.Token, map[string]string{"workspace_slug": f.Slug, "project_key": "other"}).Code)
	require.Equal(t, http.StatusForbidden, f.Do("POST", "/api/v1/cli/project-tokens", map[string]string{"workspace_slug": f.Slug, "project_key": "other"}).Code)
	require.Equal(t, http.StatusNoContent, f.DoAsAgent("DELETE", "/api/v1/me/token", key, nil).Code)
	for _, raw := range []string{key, again.Token, other.Token} {
		require.Equal(t, http.StatusUnauthorized, f.DoAsAgent("GET", "/api/v1/me", raw, nil).Code)
	}
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/me", s.key, nil).Code, "unrelated legacy token remains valid")
}

func TestSetupIssuanceChecksCurrentRoleProjectAndMembership(t *testing.T) {
	s := newScopedSetup(t)
	f := s.f
	key := approveLogin(t, f)
	issue := func(slug, project string) int {
		return f.DoAsAgent("POST", "/api/v1/cli/project-tokens", key, map[string]string{"workspace_slug": slug, "project_key": project}).Code
	}
	require.Equal(t, http.StatusNotFound, issue("unknown", "own"))
	require.Equal(t, http.StatusNotFound, issue(f.Slug, "missing"))
	setRole(t, f, "viewer")
	require.Equal(t, http.StatusForbidden, issue(f.Slug, "own"))
	setRole(t, f, "member")
	require.Equal(t, http.StatusOK, issue(f.Slug, "own"))
	_, err := f.Pool.Exec(t.Context(), `UPDATE project SET status='archived', archived_at=now() WHERE id=$1`, s.ownProject)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, issue(f.Slug, "own"))
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, issue(f.Slug, "other"))
}

func TestLoginApprovalRequiresBrowserAndExplicitUnscopedConsent(t *testing.T) {
	f := testutil.NewFixture(t)
	personal, err := f.Store.CreateAPIToken(t.Context(), f.User.ID, "personal")
	require.NoError(t, err)
	start := cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": "login"})
	var session struct {
		UserCode string `json:"user_code"`
	}
	f.DecodeInto(start, &session)
	path := "/api/v1/cli/sessions/" + session.UserCode + "/approve"
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("POST", path, personal, map[string]string{}).Code)
	require.Equal(t, http.StatusForbidden, cliDo(f, "POST", path, map[string]string{}).Code)
	require.Equal(t, http.StatusBadRequest, f.Do("POST", path, map[string]string{"workspace_slug": f.Slug, "project_key": "own"}).Code)
	require.Equal(t, http.StatusNoContent, f.Do("POST", path, map[string]string{}).Code)
	require.Equal(t, http.StatusNotFound, f.Do("POST", path, map[string]string{}).Code)
	require.Equal(t, http.StatusBadRequest, cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": "personal"}).Code)
}

func TestSetupLoginWithoutMembershipAndBrowserCascade(t *testing.T) {
	f := testutil.NewFixture(t)
	g := *f
	g.Token = newcomer(t, f, "machine-newcomer@example.com", "New Machine")
	key := approveLogin(t, &g)
	me := g.DoAsAgent("GET", "/api/v1/me", key, nil)
	require.Equal(t, http.StatusOK, me.Code, me.Body.String())
	require.Contains(t, me.Body.String(), `"memberships":[]`)

	first := approveLogin(t, f)
	second := approveLogin(t, f)
	_, err := f.Store.CreateProject(t.Context(), store.CreateProjectInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Key: "child", Name: "Child"})
	require.NoError(t, err)
	issue := func(parent string) store.CLIGrant {
		res := f.DoAsAgent("POST", "/api/v1/cli/project-tokens", parent, map[string]string{"workspace_slug": f.Slug, "project_key": "child"})
		require.Equal(t, http.StatusOK, res.Code, res.Body.String())
		var grant store.CLIGrant
		f.DecodeInto(res, &grant)
		return grant
	}
	child1, child2 := issue(first), issue(second)
	_, parentID, _, err := f.Store.LookupAPIToken(t.Context(), first)
	require.NoError(t, err)
	res := f.Do("DELETE", "/api/v1/me/tokens/"+parentID.String(), nil)
	require.Equal(t, http.StatusNoContent, res.Code, res.Body.String())
	for _, raw := range []string{first, child1.Token} {
		require.Equal(t, http.StatusUnauthorized, f.DoAsAgent("GET", "/api/v1/me", raw, nil).Code)
	}
	for _, raw := range []string{second, child2.Token, key} {
		require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/me", raw, nil).Code)
	}
}
