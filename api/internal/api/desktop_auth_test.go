package api_test

import (
	"net/http"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/stretchr/testify/require"
)

func TestDesktopConsentKindAndRoleBoundaries(t *testing.T) {
	s := newScopedSetup(t)
	f := s.f
	setup := approveLogin(t, f)
	start := cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": "desktop", "client_name": "Velvet for macOS"})
	require.Equal(t, http.StatusCreated, start.Code, start.Body.String())
	var session struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	f.DecodeInto(start, &session)
	path := "/api/v1/cli/sessions/" + session.UserCode
	poll := func() int {
		return cliDo(f, "POST", "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode}).Code
	}
	require.Equal(t, http.StatusAccepted, poll())
	lookup := f.Do("GET", path, nil)
	require.Equal(t, http.StatusOK, lookup.Code)
	require.Contains(t, lookup.Body.String(), `"flow":"desktop"`)
	require.Equal(t, http.StatusAccepted, poll(), "viewing consent must not approve")
	for _, token := range []string{setup, s.key} {
		for _, suffix := range []string{"", "/approve", "/deny"} {
			method := "POST"
			if suffix == "" {
				method = "GET"
			}
			require.Equal(t, http.StatusForbidden, f.DoAsAgent(method, path+suffix, token, map[string]string{}).Code)
		}
	}
	require.Equal(t, http.StatusForbidden, cliDo(f, "POST", path+"/approve", map[string]string{}).Code)
	require.Equal(t, http.StatusForbidden, cookieRequestWithoutOrigin(f, "POST", path+"/approve", []byte(`{}`)).Code)
	require.Equal(t, http.StatusBadRequest, f.Do("POST", path+"/approve", map[string]string{"workspace_slug": f.Slug}).Code)
	require.ErrorIs(t, f.Store.ApproveCLIUnscoped(t.Context(), session.UserCode, f.User.ID, "login"), store.ErrNotFound)
	require.ErrorIs(t, f.Store.ApproveCLISession(t.Context(), session.UserCode, f.User.ID, f.WorkspaceID, s.ownProject), store.ErrNotFound)
	require.Equal(t, http.StatusAccepted, poll())
	require.Equal(t, http.StatusNoContent, f.Do("POST", path+"/approve", map[string]string{}).Code)
	require.Equal(t, http.StatusNotFound, f.Do("POST", path+"/approve", map[string]string{}).Code)
	collected := cliDo(f, "POST", "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	require.Equal(t, http.StatusOK, collected.Code, collected.Body.String())
	var grant store.CLIGrant
	f.DecodeInto(collected, &grant)
	require.Equal(t, "desktop", grant.Kind)
	require.Empty(t, grant.Scope)
	require.Empty(t, grant.WorkspaceSlug)
	require.Equal(t, http.StatusGone, poll())
	_, _, scope, err := f.Store.LookupAPIToken(t.Context(), grant.Token)
	require.NoError(t, err)
	require.Equal(t, "desktop", scope.Kind)
	require.False(t, scope.Scoped())
	require.Nil(t, scope.ParentID)
	me := f.DoAsAgent("GET", "/api/v1/me", grant.Token, nil)
	require.Equal(t, http.StatusOK, me.Code)
	require.Contains(t, me.Body.String(), `"token_kind":"desktop"`)
	created := f.DoAsAgent("POST", "/api/v1/orgs", grant.Token, map[string]string{"name": "Desktop Org", "slug": "desktop-org", "issue_prefix": "DES"})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	me = f.DoAsAgent("GET", "/api/v1/me", grant.Token, nil)
	require.Contains(t, me.Body.String(), `"workspace_slug":"desktop-org"`)
	require.Contains(t, me.Body.String(), `"workspace_slug":"lab"`)
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/w/desktop-org/issues", grant.Token, nil).Code)
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/w/lab/issues/"+s.otherIssue.Key, grant.Token, nil).Code)
	require.Equal(t, http.StatusOK, f.DoAsAgent("PATCH", "/api/v1/w/lab", grant.Token, map[string]string{"name": "Desktop Lab"}).Code)
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("POST", "/api/v1/cli/project-tokens", grant.Token, map[string]string{"workspace_slug": f.Slug, "project_key": "own"}).Code)
	setRole(t, f, "member")
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("PATCH", "/api/v1/w/lab", grant.Token, map[string]string{"name": "Denied"}).Code)
	setRole(t, f, "viewer")
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("POST", "/api/v1/w/lab/issues", grant.Token, map[string]string{"title": "Denied"}).Code)
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/w/lab/issues", grant.Token, nil).Code)
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, f.DoAsAgent("GET", "/api/v1/w/lab/issues", grant.Token, nil).Code)
	require.Equal(t, http.StatusNoContent, f.DoAsAgent("DELETE", "/api/v1/me/token", grant.Token, nil).Code)
	require.Equal(t, http.StatusUnauthorized, f.DoAsAgent("GET", "/api/v1/me", grant.Token, nil).Code)
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/me", setup, nil).Code)
}

func TestDesktopRefusalExpiryAndFlowBinding(t *testing.T) {
	f := newScopedSetup(t).f
	for _, flow := range []string{"login", "manage", "init"} {
		_, session, err := f.Store.CreateCLISessionForFlow(t.Context(), "Velvet for macOS", flow)
		require.NoError(t, err)
		require.ErrorIs(t, f.Store.ApproveCLIUnscoped(t.Context(), session.UserCode, f.User.ID, "desktop"), store.ErrNotFound)
	}
	for _, outcome := range []string{"denied", "expired"} {
		device, session, err := f.Store.CreateCLISessionForFlow(t.Context(), "Velvet for macOS", "desktop")
		require.NoError(t, err)
		path := "/api/v1/cli/sessions/" + session.UserCode
		want := http.StatusForbidden
		if outcome == "denied" {
			require.Equal(t, http.StatusNoContent, f.Do("POST", path+"/deny", map[string]string{}).Code)
		} else {
			_, err = f.Pool.Exec(t.Context(), `UPDATE cli_session SET expires_at=now()-interval '1 second' WHERE id=$1`, session.ID)
			require.NoError(t, err)
			want = http.StatusGone
		}
		require.Equal(t, http.StatusNotFound, f.Do("POST", path+"/approve", map[string]string{}).Code)
		require.Equal(t, want, cliDo(f, "POST", "/api/v1/cli/sessions/token", map[string]string{"device_code": device}).Code)
	}
}
