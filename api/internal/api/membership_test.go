package api_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestAdminCanListAndUpdateMemberships(t *testing.T) {
	f := testutil.NewFixture(t)
	user, err := f.Store.UpsertUserByEmail(t.Context(), "octo-cat@example.com")
	require.NoError(t, err)
	var invited store.WorkspaceMembership
	require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'member') RETURNING id`, f.WorkspaceID, user.ID).Scan(&invited.ID))

	list := f.Do(http.MethodGet, "/api/v1/w/lab/memberships", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var body struct {
		Memberships []store.WorkspaceMembership `json:"memberships"`
	}
	f.DecodeInto(list, &body)
	require.Len(t, body.Memberships, 2)
	require.Equal(t, "octo-cat@example.com", body.Memberships[0].User.Email)
	require.Equal(t, "sabari@example.com", body.Memberships[1].User.Email)
	require.NotNil(t, body.Memberships[1].User)

	update := f.Do(http.MethodPatch,
		"/api/v1/w/lab/memberships/"+invited.ID.String(),
		map[string]any{"role": "viewer"})
	require.Equal(t, http.StatusOK, update.Code, update.Body.String())
	f.DecodeInto(update, &invited)
	require.Equal(t, "viewer", invited.Role)
}

func TestMembershipManagementRequiresAdmin(t *testing.T) {
	for _, role := range []string{"member", "viewer"} {
		t.Run(role, func(t *testing.T) {
			f := testutil.NewFixture(t)
			_, err := f.Pool.Exec(t.Context(),
				`UPDATE membership SET role = $1::membership_role WHERE user_id = $2`,
				role, f.User.ID)
			require.NoError(t, err)

			paths := []struct {
				method string
				path   string
				body   any
			}{
				{http.MethodGet, "/api/v1/w/lab/memberships", nil},
				{http.MethodPatch, "/api/v1/w/lab/memberships/" + uuid.NewString(),
					map[string]any{"role": "admin"}},
				{http.MethodPost, "/api/v1/w/lab/github/sync", nil},
				{http.MethodGet, "/api/v1/w/lab/github/connect", nil},
			}
			for _, req := range paths {
				rec := f.Do(req.method, req.path, req.body)
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestOnlyAdminCannotDemoteThemselves(t *testing.T) {
	f := testutil.NewFixture(t)
	var membershipID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT id FROM membership WHERE workspace_id = $1 AND user_id = $2`,
		f.WorkspaceID, f.User.ID).Scan(&membershipID))

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/"+membershipID.String(),
		map[string]any{"role": "member"})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"code":"last_admin"`)
}

func TestViewerCanListSignedInWorkspaceMembers(t *testing.T) {
	f := testutil.NewFixture(t)
	member, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{
		ID: 2002, Login: "octocat", Name: "Octo Cat",
	})
	require.NoError(t, err)
	_, _, err = f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "pending-user@example.com", "member")
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`UPDATE membership SET role = 'viewer' WHERE user_id = $1`, f.User.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		INSERT INTO membership (workspace_id, user_id, role)
		VALUES ($1, $2, 'member')`, f.WorkspaceID, member.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/members", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Members []store.User `json:"members"`
	}
	f.DecodeInto(rec, &body)
	require.Len(t, body.Members, 2)
	require.NotNil(t, body.Members[0].GitHubLogin)
	require.NotNil(t, body.Members[1].GitHubLogin)
	require.Equal(t, "octocat", *body.Members[0].GitHubLogin)
	require.Equal(t, "sabari", *body.Members[1].GitHubLogin)
	require.NotContains(t, rec.Body.String(), "pending-user")
}

func TestMembershipUpdateRejectsCrossWorkspaceID(t *testing.T) {
	f := testutil.NewFixture(t)
	var foreignID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		WITH w AS (
			INSERT INTO workspace (name, slug) VALUES ('Foreign', 'foreign') RETURNING id
		)
		INSERT INTO membership (workspace_id, user_id, role)
		SELECT id, $1, 'member' FROM w RETURNING id`, f.User.ID).Scan(&foreignID))

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/"+foreignID.String(),
		map[string]any{"role": "viewer"})
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())

	var role string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT role::text FROM membership WHERE id = $1`, foreignID).Scan(&role))
	require.Equal(t, "member", role)
}

func TestMembershipMutationsValidateInput(t *testing.T) {
	f := testutil.NewFixture(t)

	invalidRole := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/"+uuid.NewString(), map[string]any{
		"role": "owner",
	})
	require.Equal(t, http.StatusBadRequest, invalidRole.Code, invalidRole.Body.String())

	badID := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/nope",
		map[string]any{"role": "member"})
	require.Equal(t, http.StatusBadRequest, badID.Code, badID.Body.String())
}

func TestLegacyGitHubSessionAndInvitationRoutesAreRemoved(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/api/v1/auth/github/login", http.StatusNotFound},
		{"/api/v1/auth/github/callback?code=unused&state=unused", http.StatusGone},
	} {
		rec := f.Do(http.MethodGet, tc.path, nil)
		require.Equal(t, tc.status, rec.Code, rec.Body.String())
		require.Empty(t, rec.Result().Cookies())
	}
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{"github_login": "octocat", "role": "admin"})
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), "SELECT count(*) FROM membership").Scan(&n))
	require.Equal(t, 1, n)
}
