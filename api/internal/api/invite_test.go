package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func inviteFixture(t *testing.T) (*testutil.Fixture, *recordingMailer) {
	t.Helper()
	f := testutil.NewFixture(t)
	m := &recordingMailer{}
	f.Handler = api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, api.Dependencies{Mailer: m}).Handler()
	return f, m
}

func TestInviteAdminCreateReplaceResendRevoke(t *testing.T) {
	f, mail := inviteFixture(t)
	create := func(role string) store.Invite {
		r := f.Do("POST", "/api/v1/w/lab/invites", map[string]string{"email": " NEW@EXAMPLE.COM ", "role": role})
		require.Equal(t, 201, r.Code, r.Body.String())
		require.NotContains(t, r.Body.String(), "token")
		var i store.Invite
		f.DecodeInto(r, &i)
		return i
	}
	first := create("member")
	require.Equal(t, "new@example.com", first.Email)
	require.WithinDuration(t, time.Now().Add(7*24*time.Hour), first.ExpiresAt, 3*time.Second)
	require.Len(t, mail.messages, 1)
	require.Contains(t, mail.messages[0].Text, "http://localhost:8080/invite#token=")
	oldToken := strings.Fields(strings.Split(mail.messages[0].Text, "#token=")[1])[0]
	login, err := f.Store.IssueLoginToken(t.Context(), first.Email, "192.0.2.1", &first.ID)
	require.NoError(t, err)
	second := create("viewer")
	require.NotEqual(t, first.ID, second.ID)
	_, err = f.Store.PreviewInviteToken(t.Context(), oldToken)
	require.ErrorIs(t, err, store.ErrNotFound)
	_, err = f.Store.ConfirmLogin(t.Context(), login)
	require.ErrorIs(t, err, store.ErrNotFound)
	r := f.Do("POST", "/api/v1/w/lab/invites/"+second.ID.String()+"/resend", nil)
	require.Equal(t, 200, r.Code, r.Body.String())
	var third store.Invite
	f.DecodeInto(r, &third)
	require.NotEqual(t, second.ID, third.ID)
	require.Equal(t, "viewer", third.Role)
	require.Len(t, mail.messages, 3)
	require.Equal(t, 204, f.Do("DELETE", "/api/v1/w/lab/invites/"+third.ID.String(), nil).Code)
	r = f.Do("GET", "/api/v1/w/lab/invites", nil)
	require.JSONEq(t, `{"invites":[]}`, r.Body.String())
}

func TestInviteManagementAccessAndForeignIDs(t *testing.T) {
	for _, role := range []string{"member", "viewer", "foreign"} {
		t.Run(role, func(t *testing.T) {
			f, _ := inviteFixture(t)
			i, _, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "new@example.com", "member")
			require.NoError(t, err)
			if role == "foreign" {
				_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE user_id=$1`, f.User.ID)
			} else {
				_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role=$1::membership_role WHERE user_id=$2`, role, f.User.ID)
			}
			require.NoError(t, err)
			want := 403
			if role == "foreign" {
				want = 404
			}
			for _, a := range []struct {
				method, path string
				body         any
			}{
				{"GET", "/api/v1/w/lab/invites", nil},
				{"POST", "/api/v1/w/lab/invites", map[string]string{"email": "next@example.com", "role": "member"}},
				{"POST", "/api/v1/w/lab/invites/" + i.ID.String() + "/resend", nil},
				{"DELETE", "/api/v1/w/lab/invites/" + i.ID.String(), nil},
			} {
				r := f.Do(a.method, a.path, a.body)
				require.Equal(t, want, r.Code, r.Body.String())
			}
		})
	}
	f, _ := inviteFixture(t)
	var foreign uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug) VALUES ('Foreign','foreign') RETURNING id) INSERT INTO invite(workspace_id,email,role,token_hash,invited_by,expires_at) SELECT id,'other@example.com','member','foreign',$1,now()+interval '7 days' FROM w RETURNING id`, f.User.ID).Scan(&foreign))
	require.Equal(t, 404, f.Do("POST", "/api/v1/w/lab/invites/"+foreign.String()+"/resend", nil).Code)
	require.Equal(t, 404, f.Do("DELETE", "/api/v1/w/lab/invites/"+foreign.String(), nil).Code)
	for _, body := range []map[string]string{{"email": "x@example.com", "role": "owner"}, {"email": "Name <x@example.com>", "role": "member"}} {
		require.Equal(t, 400, f.Do("POST", "/api/v1/w/lab/invites", body).Code)
	}
}

func TestInvitePreviewReadOnlyAndAcceptanceByIdentity(t *testing.T) {
	for _, mode := range []string{"token", "id", "wrong token email", "foreign id"} {
		t.Run(mode, func(t *testing.T) {
			f, mail := inviteFixture(t)
			email := f.User.Email
			if strings.Contains(mode, "wrong") || mode == "foreign id" {
				email = "other@example.com"
			}
			i, token, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, email, "member")
			require.NoError(t, err)
			r := f.Do("POST", "/api/v1/invite/preview", map[string]string{"token": token})
			require.Equal(t, 200, r.Code, r.Body.String())
			var preview map[string]any
			f.DecodeInto(r, &preview)
			require.Equal(t, true, preview["signed_in"])
			require.Equal(t, email == f.User.Email, preview["email_matches"])
			require.Equal(t, "Lab", preview["invite"].(map[string]any)["workspace_name"])
			require.Equal(t, "lab", preview["invite"].(map[string]any)["workspace_slug"])
			require.NotContains(t, r.Body.String(), "token")
			require.Empty(t, mail.messages)
			list := f.Do("GET", "/api/v1/me/invites", nil)
			require.Equal(t, 200, list.Code, list.Body.String())
			if email == f.User.Email {
				require.Contains(t, list.Body.String(), i.ID.String())
				require.Contains(t, list.Body.String(), `"workspace_name":"Lab"`)
			} else {
				require.JSONEq(t, `{"invites":[]}`, list.Body.String())
			}
			if mode == "id" || mode == "foreign id" {
				r = f.Do("POST", "/api/v1/me/invites/"+i.ID.String()+"/accept", nil)
			} else {
				r = f.Do("POST", "/api/v1/invite/accept", map[string]string{"token": token})
			}
			want := 200
			if mode == "wrong token email" {
				want = 403
			}
			if mode == "foreign id" {
				want = 404
			}
			require.Equal(t, want, r.Code, r.Body.String())
			if want == 200 {
				var m store.Membership
				f.DecodeInto(r, &m)
				require.Equal(t, "admin", m.Role)
			}
		})
	}
}

func TestInviteSignedOutAcceptanceUsesSharedLimitsAndConfirmation(t *testing.T) {
	f, m := inviteFixture(t)
	i, token, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "new@example.com", "viewer")
	require.NoError(t, err)
	f.Token = ""
	r := f.Do("POST", "/api/v1/invite/preview", map[string]string{"token": token})
	require.Equal(t, 200, r.Code, r.Body.String())
	require.Contains(t, r.Body.String(), `"signed_in":false`)
	require.Empty(t, m.messages)
	for range 4 {
		require.Equal(t, 202, f.Do("POST", "/api/v1/auth/email", map[string]string{"email": i.Email}).Code)
	}
	for range 2 {
		r = f.Do("POST", "/api/v1/invite/accept", map[string]string{"token": token})
		require.Equal(t, 202, r.Code, r.Body.String())
	}
	require.Len(t, m.messages, 5)
	login := strings.Fields(strings.Split(m.messages[4].Text, "#token=")[1])[0]
	r = f.Do("POST", "/api/v1/auth/magic", map[string]string{"token": login})
	require.Equal(t, 200, r.Code, r.Body.String())
	require.JSONEq(t, `{"next":"/w/lab"}`, r.Body.String())
	user, err := f.Store.UserBySessionToken(t.Context(), r.Result().Cookies()[0].Value)
	require.NoError(t, err)
	membership, err := f.Store.MembershipForSlug(t.Context(), user.ID, "lab")
	require.NoError(t, err)
	require.Equal(t, "viewer", membership.Role)
	require.Equal(t, 410, f.Do("POST", "/api/v1/invite/accept", map[string]string{"token": token}).Code)
	require.Equal(t, 401, f.Do(http.MethodGet, "/api/v1/me/invites", nil).Code)
}

func TestInviteAcceptCreatesMembershipForEachRole(t *testing.T) {
	for _, role := range []string{"admin", "member", "viewer"} {
		for _, mode := range []string{"id", "token"} {
			t.Run(role+"/"+mode, func(t *testing.T) {
				f, _ := inviteFixture(t)
				u, err := f.Store.UpsertUserByEmail(t.Context(), "new@example.com")
				require.NoError(t, err)
				i, token, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, u.Email, role)
				require.NoError(t, err)
				f.Token, err = f.Store.CreateSession(t.Context(), u.ID, time.Hour)
				require.NoError(t, err)
				path, body := "/api/v1/me/invites/"+i.ID.String()+"/accept", any(nil)
				if mode == "token" {
					path, body = "/api/v1/invite/accept", map[string]string{"token": token}
				}
				r := f.Do("POST", path, body)
				require.Equal(t, 200, r.Code, r.Body.String())
				var m store.Membership
				f.DecodeInto(r, &m)
				require.Equal(t, role, m.Role)
				require.Equal(t, f.WorkspaceID, m.WorkspaceID)
				last, err := f.Store.LastWorkspace(t.Context(), f.Token)
				require.NoError(t, err)
				require.NotNil(t, last)
				require.Equal(t, m, *last)
				require.Equal(t, 410, f.Do("POST", path, body).Code)
			})
		}
	}
}

func TestInviteDeadLinksCannotIssueLoginMail(t *testing.T) {
	for _, state := range []string{"expired", "revoked", "accepted", "missing"} {
		t.Run(state, func(t *testing.T) {
			f, m := inviteFixture(t)
			i, token, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "new@example.com", "member")
			require.NoError(t, err)
			switch state {
			case "expired":
				_, err = f.Pool.Exec(t.Context(), `UPDATE invite SET expires_at=now()-interval '1 second' WHERE id=$1`, i.ID)
			case "revoked":
				err = f.Store.RevokeInvite(t.Context(), f.WorkspaceID, i.ID, f.User.ID)
			case "accepted":
				_, err = f.Pool.Exec(t.Context(), `UPDATE invite SET accepted_at=now() WHERE id=$1`, i.ID)
			case "missing":
				token = "no-such-token"
			}
			require.NoError(t, err)
			f.Token = ""
			for _, path := range []string{"/api/v1/invite/preview", "/api/v1/invite/accept"} {
				r := f.Do("POST", path, map[string]string{"token": token})
				require.Equal(t, 410, r.Code, r.Body.String())
				require.Contains(t, r.Body.String(), `"code":"expired"`)
			}
			require.Empty(t, m.messages)
			var count int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&count))
			require.Zero(t, count)
		})
	}
}
