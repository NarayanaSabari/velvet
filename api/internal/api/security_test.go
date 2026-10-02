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
		`WITH p AS (INSERT INTO project (workspace_id, key, name) VALUES ($1, 'secret', 'Secret') RETURNING id)
		 INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on)
		 SELECT $1, p.id, 'Secret sprint', '2026-09-01', '2026-09-30' FROM p`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/other/sprints", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.NotContains(t, rec.Body.String(), "Secret sprint")
}

// A viewer must not be able to mutate.
func TestSecurityViewerCannotCreateSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	viewer, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 4242, Login: "viewer"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role)
		 VALUES ($1, $2, 'viewer')`, f.WorkspaceID, viewer.ID)
	require.NoError(t, err)

	tok, err := f.Store.CreateSession(ctx, viewer.ID, time.Hour)
	require.NoError(t, err)

	orig := f.Token
	f.Token = tok
	defer func() { f.Token = orig }()

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Nope", "starts_on": "2026-09-01", "ends_on": "2026-09-30", "project_id": f.SprintProject().String()})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// Sprint lifecycle is ordinary work rather than administration, so a member
// may run it. A viewer reads the record without writing it.
func TestSecurityViewerCannotManageSprintLifecycle(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	viewer, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 4343, Login: "viewer"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role)
		 VALUES ($1, $2, 'viewer')`, f.WorkspaceID, viewer.ID)
	require.NoError(t, err)
	tok, err := f.Store.CreateSession(ctx, viewer.ID, time.Hour)
	require.NoError(t, err)
	f.Token = tok

	created := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Nope", "starts_on": "2026-09-01", "ends_on": "2026-09-30", "project_id": f.SprintProject().String()})
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

// GitHub identity is optional attribution, never workspace authorization.
func TestEmailOnlyWorkspaceAccessUsesMembershipRole(t *testing.T) {
	for _, role := range []string{"member", "viewer"} {
		t.Run(role, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			project := createProject(t, f, map[string]any{"key": "client", "name": "Client"})
			issue := createIssue(t, f, map[string]any{"title": "Linked work", "project_id": project.ID.String()})
			pr := testutil.InsertPullRequest(t, f, 42, "Linked work", "open")
			attached := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
				map[string]any{"reference": "acme/widgets#42"})
			require.Equal(t, http.StatusCreated, attached.Code, attached.Body.String())
			user, err := f.Store.UpsertUserByEmail(ctx, role+"@example.com")
			require.NoError(t, err)
			require.Nil(t, user.GitHubID)
			require.Nil(t, user.GitHubLogin)
			_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3::membership_role)`, f.WorkspaceID, user.ID, role)
			require.NoError(t, err)
			f.Token, err = f.Store.CreateSession(ctx, user.ID, time.Hour)
			require.NoError(t, err)
			for _, path := range []string{
				"/api/v1/w/lab/issues", "/api/v1/w/lab/issues/" + issue.Key,
				"/api/v1/w/lab/projects", "/api/v1/w/lab/projects/client",
				"/api/v1/w/lab/issues/" + issue.Key + "/comments",
			} {
				read := f.Do(http.MethodGet, path, nil)
				require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			}
			read := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			require.Contains(t, read.Body.String(), pr.ID.String())
			identity := f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
			require.Equal(t, http.StatusOK, identity.Code, identity.Body.String())
			require.JSONEq(t, `{"identity":null}`, identity.Body.String())
			for _, request := range []struct {
				method, path string
				body         map[string]any
				status       int
			}{
				{http.MethodPost, "/api/v1/w/lab/issues", map[string]any{"title": "New issue"}, http.StatusCreated},
				{http.MethodPatch, "/api/v1/w/lab/issues/" + issue.Key, map[string]any{"title": "Updated issue"}, http.StatusOK},
				{http.MethodPost, "/api/v1/w/lab/issues/" + issue.Key + "/comments", map[string]any{"body": "Client update"}, http.StatusCreated},
				{http.MethodPost, "/api/v1/w/lab/projects", map[string]any{"key": "new-project", "name": "New project"}, http.StatusCreated},
			} {
				status := request.status
				if role == "viewer" {
					status = http.StatusForbidden
				}
				write := f.Do(request.method, request.path, request.body)
				require.Equal(t, status, write.Code, write.Body.String())
			}
		})
	}
}
