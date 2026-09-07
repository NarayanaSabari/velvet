package api_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestAdminCanInviteListAndUpdateMemberships(t *testing.T) {
	f := testutil.NewFixture(t)

	invite := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
		"github_login": "Octo-Cat",
		"role":         "member",
	})
	require.Equal(t, http.StatusCreated, invite.Code, invite.Body.String())

	var invited store.WorkspaceMembership
	f.DecodeInto(invite, &invited)
	require.Equal(t, "octo-cat", invited.InvitedLogin)
	require.Equal(t, "member", invited.Role)
	require.Nil(t, invited.User)

	list := f.Do(http.MethodGet, "/api/v1/w/lab/memberships", nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var body struct {
		Memberships []store.WorkspaceMembership `json:"memberships"`
	}
	f.DecodeInto(list, &body)
	require.Len(t, body.Memberships, 2)
	require.Equal(t, "octo-cat", body.Memberships[0].InvitedLogin)
	require.Equal(t, "sabari", body.Memberships[1].InvitedLogin)
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
				{http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
					"github_login": "new-user", "role": "member",
				}},
				{http.MethodPatch, "/api/v1/w/lab/memberships/" + uuid.NewString(),
					map[string]any{"role": "admin"}},
				{http.MethodPost, "/api/v1/w/lab/repos", map[string]any{
					"github_id": 1, "owner": "acme", "name": "widgets", "installation_id": 2,
				}},
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
	member, err := f.Store.UpsertUserByGitHub(t.Context(), store.GitHubIdentity{
		ID: 2002, Login: "octocat", Name: "Octo Cat",
	})
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`UPDATE membership SET role = 'viewer' WHERE user_id = $1`, f.User.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		INSERT INTO membership (workspace_id, user_id, invited_login, role)
		VALUES ($1, $2, 'octocat', 'member')`, f.WorkspaceID, member.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		INSERT INTO membership (workspace_id, invited_login, role)
		VALUES ($1, 'pending-user', 'member')`, f.WorkspaceID)
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
		INSERT INTO membership (workspace_id, invited_login, role)
		SELECT id, 'outsider', 'member' FROM w RETURNING id`).Scan(&foreignID))

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

	invalidLogin := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
		"github_login": "not a github login",
		"role":         "member",
	})
	require.Equal(t, http.StatusBadRequest, invalidLogin.Code, invalidLogin.Body.String())

	invalidRole := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
		"github_login": "octocat",
		"role":         "owner",
	})
	require.Equal(t, http.StatusBadRequest, invalidRole.Code, invalidRole.Body.String())

	badID := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/nope",
		map[string]any{"role": "member"})
	require.Equal(t, http.StatusBadRequest, badID.Code, badID.Body.String())
}

func TestReinvitingLoginIsCaseInsensitiveAndKeepsExistingRole(t *testing.T) {
	f := testutil.NewFixture(t)
	first := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
		"github_login": "OctoCat", "role": "member",
	})
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())
	second := f.Do(http.MethodPost, "/api/v1/w/lab/memberships", map[string]any{
		"github_login": "OCTOCAT", "role": "viewer",
	})
	require.Equal(t, http.StatusConflict, second.Code, second.Body.String())

	var count int
	var role string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT count(*), max(role::text)
		FROM membership
		WHERE workspace_id = $1 AND lower(invited_login) = 'octocat'`, f.WorkspaceID).
		Scan(&count, &role))
	require.Equal(t, 1, count)
	require.Equal(t, "member", role)
}
