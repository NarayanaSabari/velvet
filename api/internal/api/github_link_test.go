package api_test

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

type githubAuthStub struct {
	server         *httptest.Server
	client         *github.UserClient
	mu             sync.Mutex
	challenges     map[string]string
	exchanges      int
	fail           bool
	beforeExchange func()
}

func newGitHubAuthStub(t *testing.T) *githubAuthStub {
	t.Helper()
	stub := &githubAuthStub{challenges: map[string]string{}}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.mu.Lock()
		defer stub.mu.Unlock()
		switch r.URL.Path {
		case "/authorize":
			require.Equal(t, "S256", r.URL.Query().Get("code_challenge_method"))
			state := r.URL.Query().Get("state")
			code := "code-" + state
			stub.challenges[code] = r.URL.Query().Get("code_challenge")
			http.Redirect(w, r, r.URL.Query().Get("redirect_uri")+"?state="+url.QueryEscape(state)+"&code="+url.QueryEscape(code), 302)
		case "/token":
			stub.exchanges++
			if stub.beforeExchange != nil {
				stub.beforeExchange()
			}
			require.NoError(t, r.ParseForm())
			digest := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if stub.fail || stub.challenges[r.Form.Get("code")] == "" || stub.challenges[r.Form.Get("code")] != base64.RawURLEncoding.EncodeToString(digest[:]) {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"provider-secret"}`))
				return
			}
			delete(stub.challenges, r.Form.Get("code"))
			_, _ = w.Write([]byte(`{"access_token":"temporary-secret","refresh_token":"refresh-secret","token_type":"bearer"}`))
		case "/user":
			require.Equal(t, "Bearer temporary-secret", r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(`{"id":42,"login":"linked-owner"}`))
		case "/user/installations":
			require.Equal(t, "Bearer temporary-secret", r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(`{"total_count":1,"installations":[{"id":99,"account":{"id":42,"login":"linked-owner","type":"User"}}]}`))
		default:
			t.Errorf("unexpected GitHub endpoint %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(stub.server.Close)
	var err error
	stub.client, err = github.NewUserClient(github.UserClientConfig{ClientID: "app-client", ClientSecret: "app-secret", AuthorizationURL: stub.server.URL + "/authorize", TokenURL: stub.server.URL + "/token", APIURL: stub.server.URL, RedirectURL: "http://localhost:8080/api/v1/auth/github/callback"})
	require.NoError(t, err)
	return stub
}

func githubRequest(h http.Handler, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func githubCallback(t *testing.T, location string) string {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(location)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 302, resp.StatusCode)
	u, err := url.Parse(resp.Header.Get("Location"))
	require.NoError(t, err)
	return u.RequestURI()
}

func TestGitHubLinkRoundtripSessionSwitchReplayAndUnlink(t *testing.T) {
	f := testutil.NewFixture(t)
	stub := newGitHubAuthStub(t)
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, api.Dependencies{GitHubUser: stub.client}).Handler()
	require.Equal(t, 401, githubRequest(h, "GET", "/api/v1/auth/github/link", "").Code)
	start := githubRequest(h, "GET", "/api/v1/auth/github/link", f.Token)
	require.Equal(t, 302, start.Code, start.Body.String())
	callback := githubCallback(t, start.Header().Get("Location"))
	other, err := f.Store.CreateSession(t.Context(), f.User.ID, time.Hour)
	require.NoError(t, err)
	wrong := githubRequest(h, "GET", callback, other)
	require.Equal(t, 410, wrong.Code)
	require.Zero(t, stub.exchanges)
	stub.beforeExchange = func() {
		var spent bool
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT claimed_at IS NOT NULL AND verifier='' FROM github_authorization_state`).Scan(&spent))
		require.True(t, spent)
	}
	done := githubRequest(h, "GET", callback, f.Token)
	require.Equal(t, 302, done.Code, done.Body.String())
	require.Equal(t, "/", done.Header().Get("Location"))
	require.Empty(t, done.Result().Cookies())
	user, err := f.Store.UserBySessionToken(t.Context(), f.Token)
	require.NoError(t, err)
	require.Equal(t, int64(42), *user.GitHubID)
	replay := githubRequest(h, "GET", callback, f.Token)
	require.Equal(t, 302, replay.Code)
	require.Equal(t, "/", replay.Header().Get("Location"))
	require.Equal(t, 1, stub.exchanges)
	unlinked := githubRequest(h, "DELETE", "/api/v1/me/github", f.Token)
	require.Equal(t, 204, unlinked.Code, unlinked.Body.String())
	require.Equal(t, `"cache"`, unlinked.Header().Get("Clear-Site-Data"))
	require.Equal(t, "no-referrer", done.Header().Get("Referrer-Policy"))
	require.Equal(t, 302, githubRequest(h, "GET", callback, f.Token).Code)
	me := githubRequest(h, "GET", "/api/v1/me", f.Token)
	require.Contains(t, me.Body.String(), `"github_id":null`)
	require.Contains(t, me.Body.String(), `"github_login":null`)
	require.Equal(t, "no-store", me.Header().Get("Cache-Control"))
	var sessions int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM session`).Scan(&sessions))
	require.Equal(t, 2, sessions)
}

func TestGitHubLinkFailureRequiresFreshFlow(t *testing.T) {
	for _, mode := range []string{"exchange", "pkce", "conflict", "expiry", "denied", "expired-during-exchange"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			stub := newGitHubAuthStub(t)
			h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, api.Dependencies{GitHubUser: stub.client}).Handler()
			start := githubRequest(h, "GET", "/api/v1/auth/github/link", f.Token)
			require.Equal(t, 302, start.Code)
			callback := githubCallback(t, start.Header().Get("Location"))
			status := 502
			switch mode {
			case "exchange":
				stub.fail = true
			case "pkce":
				_, err := f.Pool.Exec(t.Context(), `UPDATE github_authorization_state SET verifier='wrong-verifier'`)
				require.NoError(t, err)
			case "conflict":
				_, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 42, Login: "linked-owner"})
				require.NoError(t, err)
				status = 409
			case "expiry":
				_, err := f.Pool.Exec(t.Context(), `UPDATE github_authorization_state SET expires_at=clock_timestamp()-interval '1 second'`)
				require.NoError(t, err)
				status = 410
			case "denied":
				callback += "&error=access_denied"
				status = 400
			case "expired-during-exchange":
				stub.beforeExchange = func() {
					_, err := f.Pool.Exec(t.Context(), `UPDATE github_authorization_state SET expires_at=clock_timestamp()-interval '1 second'`)
					require.NoError(t, err)
				}
				status = 410
			}
			rec := githubRequest(h, "GET", callback, f.Token)
			require.Equal(t, status, rec.Code, rec.Body.String())
			require.NotContains(t, rec.Body.String(), "provider-secret")
			require.Empty(t, rec.Result().Cookies())
			user, err := f.Store.UserBySessionToken(t.Context(), f.Token)
			require.NoError(t, err)
			require.Equal(t, *f.User.GitHubID, *user.GitHubID)
			var receipts int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM github_authorization_state WHERE completed_at IS NOT NULL`).Scan(&receipts))
			require.Zero(t, receipts)
			exchanges := stub.exchanges
			retry := githubRequest(h, "GET", callback, f.Token)
			require.Equal(t, 410, retry.Code, fmt.Sprintf("%s: %s", mode, retry.Body.String()))
			require.Equal(t, exchanges, stub.exchanges)
		})
	}
}

func TestGitHubLinkCallbackExpiryDuringProfileLockRollsBack(t *testing.T) {
	for _, table := range []string{"github_authorization_state", "session"} {
		t.Run(table, func(t *testing.T) {
			f := testutil.NewFixture(t)
			stub := newGitHubAuthStub(t)
			ctx := t.Context()
			h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, api.Dependencies{GitHubUser: stub.client}).Handler()
			start := githubRequest(h, "GET", "/api/v1/auth/github/link", f.Token)
			require.Equal(t, 302, start.Code)
			callback := githubCallback(t, start.Header().Get("Location"))
			_, err := f.Pool.Exec(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+interval '600 milliseconds'`)
			require.NoError(t, err)
			blocker, err := f.Pool.Begin(ctx)
			require.NoError(t, err)
			defer blocker.Rollback(ctx)
			_, err = blocker.Exec(ctx, `UPDATE app_user SET name=name WHERE id=$1`, f.User.ID)
			require.NoError(t, err)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- githubRequest(h, "GET", callback, f.Token) }()
			require.Eventually(t, func() bool {
				var n int
				err := f.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE app_user SET github_id%'`).Scan(&n)
				return err == nil && n > 0
			}, time.Second, 10*time.Millisecond)
			require.Eventually(t, func() bool {
				var expired bool
				err := f.Pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM `+table).Scan(&expired)
				return err == nil && expired
			}, time.Second, 10*time.Millisecond)
			require.NoError(t, blocker.Rollback(ctx))
			rec := <-done
			require.Equal(t, 410, rec.Code, rec.Body.String())
			require.Empty(t, rec.Result().Cookies())
			require.Empty(t, rec.Header().Get("Location"))
			var id int64
			var receipts int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT github_id,(SELECT count(*) FROM github_authorization_state WHERE completed_at IS NOT NULL) FROM app_user WHERE id=$1`, f.User.ID).Scan(&id, &receipts))
			require.Equal(t, *f.User.GitHubID, id)
			require.Zero(t, receipts)
			require.Equal(t, 1, stub.exchanges)
		})
	}
}
