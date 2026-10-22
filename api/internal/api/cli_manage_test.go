package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestManageConsentAndCurrentRoleBoundaries(t *testing.T) {
	f := testutil.NewFixture(t)
	start := cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": "manage"})
	require.Equal(t, http.StatusCreated, start.Code, start.Body.String())
	var session struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	f.DecodeInto(start, &session)
	path := "/api/v1/cli/sessions/" + session.UserCode
	poll := func() *httptest.ResponseRecorder {
		return cliDo(f, "POST", "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode})
	}
	require.Equal(t, http.StatusAccepted, poll().Code)
	lookup := f.Do("GET", path, nil)
	require.Equal(t, http.StatusOK, lookup.Code)
	require.Contains(t, lookup.Body.String(), `"flow":"manage"`)
	require.Equal(t, http.StatusAccepted, poll().Code, "authenticated lookup must not consent")
	personal, err := f.Store.CreateAPIToken(t.Context(), f.User.ID, "existing")
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, f.DoAsAgent("POST", path+"/approve", personal, map[string]string{}).Code)
	require.Equal(t, http.StatusForbidden, cliDo(f, "POST", path+"/approve", map[string]string{}).Code)
	require.Equal(t, http.StatusForbidden, cookieRequestWithoutOrigin(f, "POST", path+"/approve", []byte(`{}`)).Code)
	req := httptest.NewRequest("POST", path+"/approve", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, http.StatusBadRequest, f.Do("POST", path+"/approve", map[string]string{"workspace_slug": f.Slug}).Code)
	require.Equal(t, http.StatusBadRequest, f.Do("POST", path+"/approve", map[string]string{"project_key": "own"}).Code)
	require.Equal(t, http.StatusAccepted, poll().Code)
	require.Equal(t, http.StatusNoContent, f.Do("POST", path+"/approve", map[string]string{}).Code)
	require.Equal(t, http.StatusNotFound, f.Do("POST", path+"/approve", map[string]string{}).Code)
	grantResponse := poll()
	require.Equal(t, http.StatusOK, grantResponse.Code, grantResponse.Body.String())
	var grant store.CLIGrant
	f.DecodeInto(grantResponse, &grant)
	require.Equal(t, "personal", grant.Kind)
	require.True(t, strings.HasPrefix(grant.Token, "velvet_"))
	require.Empty(t, grant.Scope)
	require.Empty(t, grant.WorkspaceSlug)
	require.Empty(t, grant.ProjectKey)
	require.Equal(t, http.StatusGone, poll().Code)
	_, _, scope, err := f.Store.LookupAPIToken(t.Context(), grant.Token)
	require.NoError(t, err)
	require.Equal(t, "personal", scope.Kind)
	require.Nil(t, scope.ParentID)
	require.Nil(t, scope.ProjectID)
	require.Nil(t, scope.WorkspaceID)
	require.Equal(t, http.StatusOK, f.DoAsAgent("PATCH", "/api/v1/w/lab", grant.Token, map[string]string{"name": "Management Lab"}).Code)
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
	require.Equal(t, http.StatusOK, f.DoAsAgent("GET", "/api/v1/me", personal, nil).Code)
}

func TestManageFlowValidationAndRefusal(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, flow := range []string{"personal", "unknown", "MANAGE", " manage "} {
		require.Equal(t, http.StatusBadRequest, cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": flow}).Code)
		_, _, err := f.Store.CreateCLISessionForFlow(t.Context(), "test", flow)
		require.ErrorIs(t, err, store.ErrForbidden)
	}
	start := cliDo(f, "POST", "/api/v1/cli/sessions", map[string]string{"flow": "manage"})
	var session struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	f.DecodeInto(start, &session)
	require.Equal(t, http.StatusNoContent, f.Do("POST", "/api/v1/cli/sessions/"+session.UserCode+"/deny", map[string]string{}).Code)
	require.Equal(t, http.StatusForbidden, cliDo(f, "POST", "/api/v1/cli/sessions/token", map[string]string{"device_code": session.DeviceCode}).Code)
}
