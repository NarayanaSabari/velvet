package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

type createdAPIToken struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Token string    `json:"token"`
}

func createAPITokenThroughAPI(t *testing.T, f *testutil.Fixture, name string) createdAPIToken {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/tokens", bytes.NewBufferString(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var out createdAPIToken
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func bearerRequest(f *testutil.Fixture, method, path, token string, body []byte) *httptest.ResponseRecorder {
	f.T.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

func cookieRequestWithoutOrigin(f *testutil.Fixture, method, path string, body []byte) *httptest.ResponseRecorder {
	f.T.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

func TestAPITokenManagementIsCookieOnlyAndReturnsSecretOnce(t *testing.T) {
	f := testutil.NewFixture(t)

	created := createAPITokenThroughAPI(t, f, "laptop")
	require.Equal(t, "laptop", created.Name)
	require.True(t, len(created.Token) >= len("velvet_")+40)
	require.True(t, len(created.Token) > 7 && created.Token[:7] == "velvet_")

	listed := f.Do(http.MethodGet, "/api/v1/me/tokens", nil)
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var body struct {
		Tokens []store.APIToken `json:"tokens"`
	}
	f.DecodeInto(listed, &body)
	require.Len(t, body.Tokens, 1)
	require.Equal(t, created.ID, body.Tokens[0].ID)
	require.Equal(t, created.Name, body.Tokens[0].Name)
	require.NotContains(t, listed.Body.String(), created.Token)

	duplicate := createAPITokenRequest(f, "laptop")
	require.Equal(t, http.StatusConflict, duplicate.Code, duplicate.Body.String())
	empty := createAPITokenRequest(f, "   ")
	require.Equal(t, http.StatusBadRequest, empty.Code, empty.Body.String())

	deleted := f.Do(http.MethodDelete, "/api/v1/me/tokens/"+created.ID.String(), nil)
	require.Equal(t, http.StatusNoContent, deleted.Code, deleted.Body.String())
	listed = f.Do(http.MethodGet, "/api/v1/me/tokens", nil)
	require.Equal(t, http.StatusOK, listed.Code)
	f.DecodeInto(listed, &body)
	require.Empty(t, body.Tokens)
}

func createAPITokenRequest(f *testutil.Fixture, name string) *httptest.ResponseRecorder {
	f.T.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/me/tokens", bytes.NewBufferString(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

func TestBearerAuthWorksForReadsAndMutations(t *testing.T) {
	f := testutil.NewFixture(t)
	created := createAPITokenThroughAPI(t, f, "cli")

	me := bearerRequest(f, http.MethodGet, "/api/v1/me", created.Token, nil)
	require.Equal(t, http.StatusOK, me.Code, me.Body.String())
	require.Contains(t, me.Body.String(), f.User.ID.String())

	issue := bearerRequest(f, http.MethodPost, "/api/v1/w/lab/issues", created.Token, []byte(`{"title":"created by CLI"}`))
	require.Equal(t, http.StatusCreated, issue.Code, issue.Body.String())
	require.Contains(t, issue.Body.String(), "created by CLI")

	var lastUsed *store.APIToken
	tokens, err := f.Store.ListAPITokens(t.Context(), f.User.ID)
	require.NoError(t, err)
	for i := range tokens {
		if tokens[i].ID == created.ID {
			lastUsed = &tokens[i]
		}
	}
	require.NotNil(t, lastUsed)
	require.NotNil(t, lastUsed.LastUsedAt)
}

func TestBearerAuthRejectsInvalidAndRevokedTokens(t *testing.T) {
	f := testutil.NewFixture(t)
	invalid := bearerRequest(f, http.MethodGet, "/api/v1/me", "velvet_0000000000000000000000000000000000000000000000000000000000000000", nil)
	require.Equal(t, http.StatusUnauthorized, invalid.Code)

	// An explicit but invalid bearer credential must not fall back to a valid
	// browser cookie on the same request.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	created := createAPITokenThroughAPI(t, f, "revoked")
	deleted := f.Do(http.MethodDelete, "/api/v1/me/tokens/"+created.ID.String(), nil)
	require.Equal(t, http.StatusNoContent, deleted.Code)
	revoked := bearerRequest(f, http.MethodGet, "/api/v1/me", created.Token, nil)
	require.Equal(t, http.StatusUnauthorized, revoked.Code)
}

func TestBearerCannotManageAPITokensAndOriginOnlyProtectsCookies(t *testing.T) {
	f := testutil.NewFixture(t)
	created := createAPITokenThroughAPI(t, f, "cli")

	bearerList := bearerRequest(f, http.MethodGet, "/api/v1/me/tokens", created.Token, nil)
	require.Equal(t, http.StatusForbidden, bearerList.Code, bearerList.Body.String())
	bearerCreate := bearerRequest(f, http.MethodPost, "/api/v1/me/tokens", created.Token, []byte(`{"name":"second"}`))
	require.Equal(t, http.StatusForbidden, bearerCreate.Code, bearerCreate.Body.String())
	bearerDelete := bearerRequest(f, http.MethodDelete, "/api/v1/me/tokens/00000000-0000-0000-0000-000000000001", created.Token, nil)
	require.Equal(t, http.StatusForbidden, bearerDelete.Code, bearerDelete.Body.String())

	bearerIssue := bearerRequest(f, http.MethodPost, "/api/v1/w/lab/issues", created.Token, []byte(`{"title":"originless bearer"}`))
	require.Equal(t, http.StatusCreated, bearerIssue.Code, bearerIssue.Body.String())
	cookieIssue := cookieRequestWithoutOrigin(f, http.MethodPost, "/api/v1/w/lab/issues", []byte(`{"title":"originless cookie"}`))
	require.Equal(t, http.StatusForbidden, cookieIssue.Code, cookieIssue.Body.String())
}

func TestAPITokenManagementCapsUserAtTwentyTokens(t *testing.T) {
	f := testutil.NewFixture(t)
	for i := 0; i < 20; i++ {
		rec := createAPITokenRequest(f, "token-"+string(rune('a'+i)))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}
	rec := createAPITokenRequest(f, "token-over-limit")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
}
