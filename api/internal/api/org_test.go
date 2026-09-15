package api_test

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Organisation creation must validate identifiers and atomically grant the creator admin access.
func TestOrganisationCreateAndValidation(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, slug := range []string{"ab", "-abc", "abc-", "ABC", strings.Repeat("a", 41), "admin", "api", "auth", "check-email", "expired", "invite", "invites", "me", "new", "orgs", "settings", "signin", "signout", "w", "webhooks"} {
		r := f.Do("POST", "/api/v1/orgs", map[string]string{"name": "Example", "slug": slug, "issue_prefix": "EX"})
		require.Equal(t, 400, r.Code, "%s: %s", slug, r.Body.String())
	}
	for _, prefix := range []string{"A", "ABCDEFG", "ab", "A2", ""} {
		r := f.Do("POST", "/api/v1/orgs", map[string]string{"name": "Example", "slug": "example", "issue_prefix": prefix})
		require.Equal(t, 400, r.Code, r.Body.String())
	}
	require.Equal(t, 400, f.Do("POST", "/api/v1/orgs", map[string]string{"name": "  ", "slug": "example", "issue_prefix": "EX"}).Code)
	body := map[string]string{"name": " Example ", "slug": "example", "issue_prefix": "EX"}
	r := f.Do("POST", "/api/v1/orgs", body)
	require.Equal(t, 201, r.Code, r.Body.String())
	var m store.Membership
	f.DecodeInto(r, &m)
	require.Equal(t, "admin", m.Role)
	require.Equal(t, "Example", m.Name)
	issue, err := f.Store.CreateIssue(t.Context(), store.CreateIssueInput{WorkspaceID: m.WorkspaceID, ActorID: f.User.ID, Title: "Prefix"})
	require.NoError(t, err)
	require.Equal(t, "EX-1", issue.Key)
	require.Equal(t, 409, f.Do("POST", "/api/v1/orgs", body).Code)
	f.Token = ""
	require.Equal(t, 401, f.Do("POST", "/api/v1/orgs", body).Code)
}

func TestOrganisationCreationDoesNotRequireExistingAdminRole(t *testing.T) {
	for _, role := range []string{"admin", "member", "viewer", "no memberships"} {
		t.Run(role, func(t *testing.T) {
			f := testutil.NewFixture(t)
			var err error
			if role == "no memberships" {
				_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE user_id=$1`, f.User.ID)
			} else {
				_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role=$1::membership_role WHERE user_id=$2`, role, f.User.ID)
			}
			require.NoError(t, err)
			r := f.Do("POST", "/api/v1/orgs", map[string]string{"name": "New", "slug": "new-team", "issue_prefix": "NEW"})
			require.Equal(t, 201, r.Code, r.Body.String())
			var m store.Membership
			f.DecodeInto(r, &m)
			require.Equal(t, "admin", m.Role)
		})
	}
}

func TestOrganisationRenameRequiresAdminAndRefreshesMe(t *testing.T) {
	f := testutil.NewFixture(t)

	r := f.Do("PATCH", "/api/v1/w/lab", map[string]string{"name": "  Velvet Otter  "})
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	var workspace store.Workspace
	f.DecodeInto(r, &workspace)
	require.Equal(t, f.WorkspaceID, workspace.ID)
	require.Equal(t, "Velvet Otter", workspace.Name)
	require.Equal(t, "lab", workspace.Slug)
	require.Equal(t, "ENG", workspace.IssuePrefix)

	r = f.Do(http.MethodGet, "/api/v1/me", nil)
	require.Equal(t, http.StatusOK, r.Code, r.Body.String())
	require.Contains(t, r.Body.String(), `"workspace_name":"Velvet Otter"`)

	member, err := f.Store.UpsertUserByEmail(t.Context(), "member@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'member')`, f.WorkspaceID, member.ID)
	require.NoError(t, err)
	memberToken, err := f.Store.CreateSession(t.Context(), member.ID, time.Hour)
	require.NoError(t, err)
	memberFixture := *f
	memberFixture.Token = memberToken
	require.Equal(t, http.StatusForbidden, memberFixture.Do("PATCH", "/api/v1/w/lab", map[string]string{"name": "Nope"}).Code)
}

func TestOrganisationRenameRejectsBlankAndOverlongNames(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, name := range []string{"", "   ", strings.Repeat("a", 81)} {
		r := f.Do("PATCH", "/api/v1/w/lab", map[string]string{"name": name})
		require.Equal(t, http.StatusBadRequest, r.Code, "%q: %s", name, r.Body.String())
	}
}

// Concurrent self-removal, leave, and demotion must serialize on the workspace
// so two admins cannot each rely on the other remaining an admin.
func TestOrganisationConcurrentLastAdminMutations(t *testing.T) {
	for _, first := range []string{"leave", "remove", "demote"} {
		for _, second := range []string{"leave", "remove", "demote"} {
			t.Run(first+"/"+second, func(t *testing.T) {
				f := testutil.NewFixture(t)
				other, err := f.Store.UpsertUserByEmail(t.Context(), "admin@example.com")
				require.NoError(t, err)
				var own, otherID uuid.UUID
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM membership WHERE user_id=$1`, f.User.ID).Scan(&own))
				require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'admin') RETURNING id`, f.WorkspaceID, other.ID).Scan(&otherID))
				otherToken, err := f.Store.CreateSession(t.Context(), other.ID, time.Hour)
				require.NoError(t, err)
				f2 := *f
				f2.Token = otherToken
				start := make(chan struct{})
				codes := make(chan int, 2)
				mutate := func(f *testutil.Fixture, action string, id uuid.UUID) {
					<-start
					method, path, body := "POST", "/api/v1/w/lab/leave", any(nil)
					if action == "remove" {
						method, path = "DELETE", "/api/v1/w/lab/memberships/"+id.String()
					}
					if action == "demote" {
						method, path, body = "PATCH", "/api/v1/w/lab/memberships/"+id.String(), map[string]string{"role": "member"}
					}
					codes <- f.Do(method, path, body).Code
				}
				go mutate(f, first, own)
				go mutate(&f2, second, otherID)
				close(start)
				var successes, conflicts int
				for range 2 {
					code := <-codes
					if code == 200 || code == 204 {
						successes++
					} else if code == 409 {
						conflicts++
					} else {
						t.Errorf("unexpected status %d", code)
					}
				}
				require.Equal(t, 1, successes)
				require.Equal(t, 1, conflicts)
				var admins int
				require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM membership WHERE workspace_id=$1 AND role='admin'`, f.WorkspaceID).Scan(&admins))
				require.Equal(t, 1, admins)
			})
		}
	}
}

func TestOrganisationRemovalPreservesAuthorshipAndScopesMembershipID(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Keep authorship")
	other, err := f.Store.UpsertUserByEmail(t.Context(), "admin@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'admin')`, f.WorkspaceID, other.ID)
	require.NoError(t, err)
	var own, foreign uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM membership WHERE user_id=$1`, f.User.ID).Scan(&own))
	require.NoError(t, f.Pool.QueryRow(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug) VALUES ('Foreign','foreign') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'admin' FROM w RETURNING id`, f.User.ID).Scan(&foreign))
	require.Equal(t, 404, f.Do("DELETE", "/api/v1/w/lab/memberships/"+foreign.String(), nil).Code)
	require.Equal(t, 204, f.Do("DELETE", "/api/v1/w/lab/memberships/"+own.String(), nil).Code)
	var author uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT created_by FROM issue WHERE id=$1`, issue.ID).Scan(&author))
	require.Equal(t, f.User.ID, author)
	var activityAuthor uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT actor_id FROM activity WHERE target_id=$1 AND verb='created_issue'`, issue.ID).Scan(&activityAuthor))
	require.Equal(t, f.User.ID, activityAuthor)
	_, err = f.Store.UserBySessionToken(t.Context(), f.Token)
	require.NoError(t, err)
	require.Equal(t, 404, f.Do("GET", "/api/v1/w/lab/members", nil).Code)
	_, err = f.Store.MembershipForSlug(t.Context(), f.User.ID, "foreign")
	require.NoError(t, err)
}

func TestOrganisationMutationAccess(t *testing.T) {
	for _, role := range []string{"admin", "member", "viewer", "foreign"} {
		for _, action := range []string{"delete", "leave", "remove", "demote"} {
			t.Run(role+"/"+action, func(t *testing.T) {
				f := testutil.NewFixture(t)
				other, err := f.Store.UpsertUserByEmail(t.Context(), "other@example.com")
				require.NoError(t, err)
				var target uuid.UUID
				require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'admin') RETURNING id`, f.WorkspaceID, other.ID).Scan(&target))
				if role == "foreign" {
					_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE user_id=$1`, f.User.ID)
				} else {
					_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role=$1::membership_role WHERE user_id=$2`, role, f.User.ID)
				}
				require.NoError(t, err)
				method, path, body := "DELETE", "/api/v1/w/lab", any(map[string]string{"confirm": "lab"})
				want := 204
				switch action {
				case "leave":
					method, path, body = "POST", path+"/leave", nil
				case "remove":
					path, body = path+"/memberships/"+target.String(), nil
				case "demote":
					method, path, body = "PATCH", path+"/memberships/"+target.String(), map[string]string{"role": "member"}
					want = 200
				}
				if role == "foreign" {
					want = 404
				} else if action != "leave" && role != "admin" {
					want = 403
				}
				r := f.Do(method, path, body)
				require.Equal(t, want, r.Code, r.Body.String())
			})
		}
	}
}

func TestOrganisationLastAdminAndDeleteConfirmation(t *testing.T) {
	f := testutil.NewFixture(t)
	var id uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM membership WHERE user_id=$1`, f.User.ID).Scan(&id))
	for _, action := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/w/lab/leave", nil},
		{"DELETE", "/api/v1/w/lab/memberships/" + id.String(), nil},
		{"PATCH", "/api/v1/w/lab/memberships/" + id.String(), map[string]string{"role": "viewer"}},
	} {
		r := f.Do(action.method, action.path, action.body)
		require.Equal(t, 409, r.Code, r.Body.String())
		require.Contains(t, r.Body.String(), `"code":"last_admin"`)
	}
	require.Equal(t, 400, f.Do("DELETE", "/api/v1/w/lab", map[string]string{"confirm": "wrong"}).Code)
	require.Equal(t, 204, f.Do("DELETE", "/api/v1/w/lab", map[string]string{"confirm": "lab"}).Code)
	_, err := f.Store.UserBySessionToken(t.Context(), f.Token)
	require.NoError(t, err)
}

func TestOrganisationLastWorkspaceAndEmptyMemberships(t *testing.T) {
	f := testutil.NewFixture(t)
	var older uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug,created_at) VALUES ('Older','older',now()-interval '1 day') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'member' FROM w RETURNING workspace_id`, f.User.ID).Scan(&older))
	readMe := func() map[string]any {
		r := f.Do("GET", "/api/v1/me", nil)
		require.Equal(t, http.StatusOK, r.Code)
		var body map[string]any
		f.DecodeInto(r, &body)
		return body
	}
	body := readMe()
	require.NotNil(t, body["last_workspace"])
	require.Equal(t, "older", body["last_workspace"].(map[string]any)["workspace_slug"])
	require.Equal(t, "older", body["memberships"].([]any)[0].(map[string]any)["workspace_slug"])
	require.Equal(t, 200, f.Do("GET", "/api/v1/w/lab/members", nil).Code)
	body = readMe()
	require.Equal(t, "lab", body["last_workspace"].(map[string]any)["workspace_slug"])
	_, err := f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE workspace_id=$1`, f.WorkspaceID)
	require.NoError(t, err)
	body = readMe()
	require.Equal(t, "older", body["last_workspace"].(map[string]any)["workspace_slug"])
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE user_id=$1`, f.User.ID)
	require.NoError(t, err)
	body = readMe()
	require.Nil(t, body["last_workspace"])
	require.Equal(t, []any{}, body["memberships"])
}

func TestOrganisationLastWorkspacePreservedAfterRejectedScopedRequest(t *testing.T) {
	for _, tc := range []struct {
		name, role, method, path string
		body                     any
		status                   int
		code                     string
	}{
		{"forbidden", "viewer", "PATCH", "/api/v1/w/lab/memberships/" + uuid.NewString(), map[string]string{"role": "admin"}, 403, "forbidden"},
		{"invalid input", "admin", "DELETE", "/api/v1/w/lab", map[string]string{"confirm": "wrong"}, 400, "invalid_request"},
		{"missing resource", "admin", "GET", "/api/v1/w/lab/issues/ENG-404", nil, 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := testutil.NewFixture(t)
			_, err := f.Pool.Exec(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug) VALUES ('Other','other') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'member' FROM w`, f.User.ID)
			require.NoError(t, err)
			_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role=$1::membership_role WHERE workspace_id=$2 AND user_id=$3`, tc.role, f.WorkspaceID, f.User.ID)
			require.NoError(t, err)
			require.Equal(t, 200, f.Do("GET", "/api/v1/w/other/members", nil).Code)
			r := f.Do(tc.method, tc.path, tc.body)
			require.Equal(t, tc.status, r.Code, r.Body.String())
			require.Contains(t, r.Header().Get("Content-Type"), "application/json")
			require.Contains(t, r.Body.String(), `"code":"`+tc.code+`"`)
			r = f.Do("GET", "/api/v1/me", nil)
			require.Equal(t, 200, r.Code, r.Body.String())
			var body struct {
				LastWorkspace *store.Membership `json:"last_workspace"`
			}
			f.DecodeInto(r, &body)
			require.NotNil(t, body.LastWorkspace)
			require.Equal(t, "other", body.LastWorkspace.Slug)
		})
	}
}

func TestOrganisationLastWorkspaceRememberedAtStreamConnection(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug) VALUES ('Other','other') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'member' FROM w`, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, 200, f.Do("GET", "/api/v1/w/other/members", nil).Code)
	srv := httptest.NewServer(f.Handler)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/v1/w/lab/stream", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, ": connected\n", line)
	r := f.Do("GET", "/api/v1/me", nil)
	var body struct {
		LastWorkspace *store.Membership `json:"last_workspace"`
	}
	f.DecodeInto(r, &body)
	require.NotNil(t, body.LastWorkspace)
	require.Equal(t, "lab", body.LastWorkspace.Slug)
}

func TestOrganisationLastWorkspaceResponseBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, wantSlug string
		status         int
		handler        http.HandlerFunc
	}{
		{"implicit body", "lab", 200, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }},
		{"implicit flush", "lab", 200, func(w http.ResponseWriter, r *http.Request) { w.(http.Flusher).Flush() }},
		{"empty handler", "lab", 200, func(w http.ResponseWriter, r *http.Request) {}},
		{"no content", "lab", 204, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }},
		{"informational then failure", "other", 403, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusEarlyHints)
			api.WriteError(w, 403, "forbidden", "insufficient permission")
		}},
		{"second status ignored", "other", 403, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("denied"))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := testutil.NewFixture(t)
			_, err := f.Pool.Exec(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug) VALUES ('Other','other') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'member' FROM w`, f.User.ID)
			require.NoError(t, err)
			require.Equal(t, 200, f.Do("GET", "/api/v1/w/other/members", nil).Code)
			s := api.NewServer(f.Pool, &config.Config{}, api.Dependencies{})
			mux := http.NewServeMux()
			mux.Handle("GET /w/{slug}", s.RequireWorkspace(tc.handler))
			srv := httptest.NewServer(mux)
			defer srv.Close()
			req, err := http.NewRequestWithContext(t.Context(), "GET", srv.URL+"/w/lab", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, tc.status, resp.StatusCode)
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			if tc.name == "implicit body" {
				require.Equal(t, "ok", string(body))
			}
			if tc.name == "informational then failure" {
				require.JSONEq(t, `{"error":{"code":"forbidden","message":"insufficient permission"}}`, string(body))
			}
			last, err := f.Store.LastWorkspace(t.Context(), f.Token)
			require.NoError(t, err)
			require.NotNil(t, last)
			require.Equal(t, tc.wantSlug, last.Slug)
		})
	}
}
