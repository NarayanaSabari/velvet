package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestMeRequiresASession(t *testing.T) {
	pool := testutil.NewPostgres(t)
	cfg := &config.Config{BaseURL: "http://localhost:8080"}
	h := api.NewServer(pool, cfg).Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestMeReturnsUserAndMemberships(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	u, err := testutil.CreateLinkedUser(t, st, store.GitHubIdentity{ID: 1, Login: "sabari"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role)
		 VALUES ($1, $2, 'admin')`, wsID, u.ID)
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, u.ID, time.Hour)
	require.NoError(t, err)

	cfg := &config.Config{BaseURL: "http://localhost:8080"}
	h := api.NewServer(pool, cfg).Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"role":"admin"`)
	require.Contains(t, rec.Body.String(), `"github_login":"sabari"`)
}

func TestLogoutWithoutASessionStillClearsTheCookie(t *testing.T) {
	pool := testutil.NewPostgres(t)
	cfg := &config.Config{BaseURL: "http://localhost:8080"}
	h := api.NewServer(pool, cfg).Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	require.Equal(t, auth.CookieName, cookies[0].Name)
	require.Less(t, cookies[0].MaxAge, 0)
}
