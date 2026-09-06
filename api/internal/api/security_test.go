package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// An authenticated user who is not a member of a workspace must not read it.
func TestSecurityNonMemberCannotReachAnotherWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(ctx,
		`INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
		 VALUES ($1, 'Secret sprint', '2026-09-01', '2026-09-30')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/other/sprints", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.NotContains(t, rec.Body.String(), "Secret sprint")
}

// A viewer must not be able to mutate.
func TestSecurityViewerCannotCreateSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	viewer, err := f.Store.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 4242, Login: "viewer"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'viewer', 'viewer')`, f.WorkspaceID, viewer.ID)
	require.NoError(t, err)

	tok, err := f.Store.CreateSession(ctx, viewer.ID, time.Hour)
	require.NoError(t, err)

	orig := f.Token
	f.Token = tok
	defer func() { f.Token = orig }()

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Nope", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// Sprint lifecycle changes the reporting boundary for the whole workspace,
// so an ordinary member may not create, activate, or close one.
func TestSecurityMemberCannotManageSprintLifecycle(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	member, err := f.Store.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 4343, Login: "member"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'member', 'member')`, f.WorkspaceID, member.ID)
	require.NoError(t, err)
	tok, err := f.Store.CreateSession(ctx, member.ID, time.Hour)
	require.NoError(t, err)
	f.Token = tok

	created := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Nope", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusForbidden, created.Code, created.Body.String())
}

// A forged or random session token must never authenticate.
func TestSecurityForgedSessionTokenIsRejected(t *testing.T) {
	f := testutil.NewFixture(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: "totally-made-up-token"})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

// The raw session token must not be stored; only its hash.
func TestSecuritySessionTokenIsStoredHashedOnly(t *testing.T) {
	f := testutil.NewFixture(t)
	var stored string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT id FROM session LIMIT 1`).Scan(&stored))
	require.NotEqual(t, f.Token, stored, "a raw token in the database is replayable")
	require.Equal(t, store.HashToken(f.Token), stored)
}
