package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/stretchr/testify/require"
)

func TestInstallationSuspensionRequiresAuthoritativeState(t *testing.T) {
	key := testKeyPEM(t)
	for _, tc := range []struct {
		name, body  string
		status      int
		want, error bool
	}{
		{"active", `{"id":99,"suspended_at":null}`, 200, false, false},
		{"suspended", `{"id":99,"suspended_at":"2026-09-08T10:00:00Z"}`, 200, true, false},
		{"wrong-id", `{"id":100,"suspended_at":null}`, 200, false, true},
		{"missing-state", `{"id":99}`, 200, false, true},
		{"invalid-time", `{"id":99,"suspended_at":"no"}`, 200, false, true},
		{"zero-time", `{"id":99,"suspended_at":"0001-01-01T00:00:00Z"}`, 200, false, true},
		{"not-found", `{"message":"provider-private-token"}`, 404, false, true},
		{"rate-limit", `{"message":"provider-private-token"}`, 429, false, true},
		{"redirect", `{"id":99,"suspended_at":null}`, 307, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, http.MethodGet, r.Method)
				require.Equal(t, "/app/installations/99", r.URL.Path)
				require.Len(t, strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "."), 3, "state checks must use an App assertion")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()
			client, err := github.NewClient("123", key, srv.URL)
			require.NoError(t, err)
			got, err := client.InstallationSuspended(t.Context(), 99)
			if tc.error {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "provider-private-token")
			} else {
				require.NoError(t, err)
				require.Equal(t, tc.want, got)
			}
		})
	}
}

// The shared App client must never forward an installation credential to a pagination origin supplied by a response.
func TestAppPaginationCannotSendTokenToForeignOrigin(t *testing.T) {
	calls := 0
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; fmt.Fprint(w, `[]`) }))
	defer foreign.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{"token": "private-token", "expires_at": time.Now().Add(time.Hour)})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s/steal>; rel="next"`, foreign.URL))
		fmt.Fprint(w, `[]`)
	}))
	defer srv.Close()
	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)
	_, err = c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.Error(t, err)
	require.Zero(t, calls)
}

func TestListInstallationRepositoriesCompleteAndSafe(t *testing.T) {
	key := testKeyPEM(t)
	for _, mode := range []string{"complete", "foreign-origin", "wrong-path", "cycle", "missing-rel", "missing-array", "missing-count", "count-mismatch", "duplicate", "error", "redirect", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			foreignCalls := 0
			foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreignCalls++; w.WriteHeader(500) }))
			defer foreign.Close()
			var srv *httptest.Server
			srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/app/installations/99/access_tokens" {
					json.NewEncoder(w).Encode(map[string]any{"token": "private-token", "expires_at": time.Now().Add(time.Hour)})
					return
				}
				require.Equal(t, "/installation/repositories", r.URL.Path)
				if mode == "redirect" {
					http.Redirect(w, r, foreign.URL, 307)
					return
				}
				if mode == "error" {
					w.WriteHeader(500)
					fmt.Fprint(w, `{"message":"private-token"}`)
					return
				}
				if mode == "oversized" {
					fmt.Fprint(w, `{"total_count":0,"repositories":[],"extra":"`)
					for range 2200000 {
						fmt.Fprint(w, "x")
					}
					fmt.Fprint(w, `"}`)
					return
				}
				if mode == "missing-array" {
					fmt.Fprint(w, `{"total_count":0}`)
					return
				}
				if mode == "missing-count" {
					fmt.Fprint(w, `{"repositories":[]}`)
					return
				}
				if r.URL.Query().Get("page") == "2" {
					id := 556
					if mode == "duplicate" {
						id = 555
					}
					if mode == "cycle" {
						w.Header().Set("Link", fmt.Sprintf(`<%s/installation/repositories?page=2>; rel="next"`, srv.URL))
					}
					fmt.Fprintf(w, `{"total_count":2,"repositories":[{"id":%d,"name":"second","owner":{"login":"acme"}}]}`, id)
					return
				}
				next := srv.URL + "/installation/repositories?page=2"
				if mode == "foreign-origin" {
					next = foreign.URL + "/installation/repositories?page=2"
				}
				if mode == "wrong-path" {
					next = srv.URL + "/private"
				}
				link := fmt.Sprintf(`<%s>; rel="next"`, next)
				if mode == "missing-rel" {
					link = fmt.Sprintf(`<%s>`, next)
				}
				if mode != "count-mismatch" {
					w.Header().Set("Link", link)
				}
				fmt.Fprint(w, `{"total_count":2,"repositories":[{"id":555,"name":"first","owner":{"login":"acme"}}]}`)
			}))
			defer srv.Close()
			c, err := github.NewClient("123", key, srv.URL)
			require.NoError(t, err)
			repos, err := c.ListInstallationRepositories(t.Context(), 99)
			if mode == "complete" {
				require.NoError(t, err)
				require.Len(t, repos, 2)
				require.Equal(t, int64(556), repos[1].ID)
			} else {
				require.ErrorIs(t, err, github.ErrInstallationRepositories)
				require.Nil(t, repos)
				require.NotContains(t, err.Error(), "private-token")
			}
			require.Zero(t, foreignCalls)
		})
	}
}
