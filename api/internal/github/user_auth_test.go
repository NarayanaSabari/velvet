package github_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/stretchr/testify/require"
)

// Trusting installation visibility without account ownership would grant repository readers access.
func TestGitHubUserAuthorizationOwnership(t *testing.T) {
	for _, tc := range []struct {
		name, accountType, memberships string
		owner                          int64
		visible, fail, allowed         bool
	}{
		{"personal owner", "User", `[]`, 42, true, false, true},
		{"other personal owner", "User", `[]`, 43, true, false, false},
		{"organisation admin", "Organization", `[{"state":"active","role":"admin","organization":{"id":43}}]`, 43, true, false, true},
		{"repository reader", "Organization", `[{"state":"active","role":"member","organization":{"id":43}}]`, 43, true, false, false},
		{"pending admin", "Organization", `[{"state":"pending","role":"admin","organization":{"id":43}}]`, 43, true, false, false},
		{"foreign installation", "User", `[]`, 42, false, false, false},
		{"unsupported account", "Enterprise", `[]`, 42, true, false, false},
		{"provider failure", "User", `[]`, 42, true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/app/installations/99/access_tokens" {
					require.True(t, strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ey"))
					_ = json.NewEncoder(w).Encode(map[string]any{"token": "app-installation-token", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
					return
				}
				if r.URL.Path == "/token" {
					require.NoError(t, r.ParseForm())
					require.Equal(t, "original-verifier", r.Form.Get("code_verifier"))
					require.Equal(t, "app-client", r.Form.Get("client_id"))
					_, _ = w.Write([]byte(`{"access_token":"temporary-secret","refresh_token":"discard-me","token_type":"bearer"}`))
					return
				}
				require.Equal(t, "Bearer temporary-secret", r.Header.Get("Authorization"))
				if tc.fail {
					w.WriteHeader(503)
					_, _ = w.Write([]byte("private-provider-body"))
					return
				}
				switch r.URL.Path {
				case "/user":
					_, _ = w.Write([]byte(`{"id":42,"login":"owner"}`))
				case "/user/installations":
					installations := []any{}
					if tc.visible {
						installations = append(installations, map[string]any{"id": 99, "account": map[string]any{"id": tc.owner, "login": "account", "type": tc.accountType}})
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"total_count": len(installations), "installations": installations})
				case "/user/memberships/orgs":
					_, _ = w.Write([]byte(tc.memberships))
				default:
					t.Errorf("unexpected endpoint %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer stub.Close()
			if tc.name == "repository reader" || tc.name == "foreign installation" {
				app, err := github.NewClient("123", testKeyPEM(t), stub.URL)
				require.NoError(t, err)
				_, err = app.InstallationToken(t.Context(), 99)
				require.NoError(t, err)
			}
			client, err := github.NewUserClient(github.UserClientConfig{ClientID: "app-client", ClientSecret: "app-secret", AuthorizationURL: stub.URL + "/authorize", TokenURL: stub.URL + "/token", APIURL: stub.URL, RedirectURL: "https://velvet.example/api/v1/auth/github/callback"})
			require.NoError(t, err)
			result, err := client.Authorize(context.Background(), "one-code", "original-verifier", 99)
			if !tc.allowed {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "private-provider-body")
				require.NotContains(t, err.Error(), "temporary-secret")
				return
			}
			require.NoError(t, err)
			require.Equal(t, int64(42), result.User.ID)
			require.Equal(t, int64(99), result.Installation.ID)
			require.Equal(t, tc.owner, result.Installation.AccountID)
		})
	}
}

// Even a matching owner on page one cannot authorize an incomplete or unsafe listing.
func TestGitHubUserAuthorizationRejectsIncompleteAndUnsafePages(t *testing.T) {
	for _, mode := range []string{"cross-origin", "redirect", "later-failure", "malformed-link", "missing-rel", "missing-total", "null-installations", "null-memberships", "unknown-member", "duplicate", "truncated", "missing-login"} {
		t.Run(mode, func(t *testing.T) {
			leaked := false
			foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.WriteHeader(500) }))
			defer foreign.Close()
			var origin string
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/token":
					_, _ = w.Write([]byte(`{"access_token":"temporary","token_type":"bearer"}`))
				case "/user":
					if mode == "missing-login" {
						_, _ = w.Write([]byte(`{"id":42}`))
						return
					}
					_, _ = w.Write([]byte(`{"id":42,"login":"owner"}`))
				case "/user/installations":
					if mode == "missing-total" {
						_, _ = w.Write([]byte(`{"installations":[]}`))
						return
					}
					if mode == "null-installations" {
						_, _ = w.Write([]byte(`{"total_count":0,"installations":null}`))
						return
					}
					if mode == "truncated" {
						_, _ = w.Write([]byte(`{"total_count":2,"installations":[{"id":99,"account":{"id":43,"login":"org","type":"Organization"}}]}`))
						return
					}
					_, _ = w.Write([]byte(`{"total_count":1,"installations":[{"id":99,"account":{"id":43,"login":"org","type":"Organization"}}]}`))
				case "/user/memberships/orgs":
					if r.URL.Query().Get("page") == "2" {
						w.WriteHeader(503)
						return
					}
					switch mode {
					case "cross-origin":
						w.Header().Set("Link", `<`+foreign.URL+`/user/memberships/orgs?page=2>; rel="next"`)
					case "redirect":
						http.Redirect(w, r, foreign.URL, http.StatusFound)
						return
					case "later-failure":
						w.Header().Set("Link", `<`+origin+`/user/memberships/orgs?page=2>; rel="next"`)
					case "malformed-link":
						w.Header().Set("Link", "broken")
					case "missing-rel":
						w.Header().Set("Link", `<`+origin+`/user/memberships/orgs?page=2>; title="next"`)
					case "null-memberships":
						_, _ = w.Write([]byte(`null`))
						return
					case "unknown-member":
						_, _ = w.Write([]byte(`[{"state":"active","role":"owner","organization":{"id":43}}]`))
						return
					case "duplicate":
						_, _ = w.Write([]byte(`[{"state":"active","role":"admin","organization":{"id":43}},{"state":"active","role":"admin","organization":{"id":43}}]`))
						return
					}
					_, _ = w.Write([]byte(`[{"state":"active","role":"admin","organization":{"id":43}}]`))
				}
			}))
			defer stub.Close()
			origin = stub.URL
			client, err := github.NewUserClient(github.UserClientConfig{ClientID: "client", ClientSecret: "secret", AuthorizationURL: origin + "/authorize", TokenURL: origin + "/token", APIURL: origin, RedirectURL: "https://velvet.example/callback"})
			require.NoError(t, err)
			_, err = client.Authorize(t.Context(), "code", "verifier", 99)
			require.ErrorIs(t, err, github.ErrUserAuthorization)
			require.False(t, leaked)
		})
	}
}

func TestGitHubUserAuthorizationPKCEAndPagination(t *testing.T) {
	var origin string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			require.NoError(t, r.ParseForm())
			if r.Form.Get("code_verifier") != "correct" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"incorrect_code_verifier","error_description":"secret"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"temporary","token_type":"bearer"}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":42,"login":"owner"}`))
		case "/user/installations":
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`{"total_count":2,"installations":[{"id":99,"account":{"id":43,"login":"org","type":"Organization"}}]}`))
				return
			}
			w.Header().Set("Link", `<`+origin+`/user/installations?per_page=100&page=2>; rel="next"`)
			_, _ = w.Write([]byte(`{"total_count":2,"installations":[{"id":98,"account":{"id":1,"login":"other","type":"User"}}]}`))
		case "/user/memberships/orgs":
			if r.URL.Query().Get("page") == "2" {
				_, _ = w.Write([]byte(`[{"state":"active","role":"admin","organization":{"id":43}}]`))
				return
			}
			w.Header().Set("Link", `<`+origin+`/user/memberships/orgs?per_page=100&page=2>; rel="next"`)
			_, _ = w.Write([]byte(`[{"state":"active","role":"member","organization":{"id":1}}]`))
		}
	}))
	defer stub.Close()
	origin = stub.URL
	client, err := github.NewUserClient(github.UserClientConfig{ClientID: "client", ClientSecret: "secret", AuthorizationURL: origin + "/authorize", TokenURL: origin + "/token", APIURL: origin, RedirectURL: "https://velvet.example/callback"})
	require.NoError(t, err)
	u, err := url.Parse(client.AuthorizationURL("state-value", "challenge-value"))
	require.NoError(t, err)
	require.Equal(t, "S256", u.Query().Get("code_challenge_method"))
	require.Equal(t, "challenge-value", u.Query().Get("code_challenge"))
	require.Equal(t, "state-value", u.Query().Get("state"))
	require.Empty(t, u.Query().Get("scope"))
	_, err = client.Authorize(t.Context(), "code", "bad", 99)
	require.Error(t, err)
	require.False(t, strings.Contains(err.Error(), "secret"))
	result, err := client.Authorize(t.Context(), "code", "correct", 99)
	require.NoError(t, err)
	require.Equal(t, int64(99), result.Installation.ID)
}
