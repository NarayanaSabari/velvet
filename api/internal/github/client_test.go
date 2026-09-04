package github_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
)

// testKeyPEM generates a throwaway RSA key for this process only. Generating
// beats committing: nothing secret ever reaches the repository.
func testKeyPEM(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

func TestInstallationTokenIsCached(t *testing.T) {
	var mints int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			atomic.AddInt32(&mints, 1)
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339),
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	for i := 0; i < 3; i++ {
		tok, err := c.InstallationToken(context.Background(), 99)
		require.NoError(t, err)
		require.Equal(t, "stub-installation-token", tok)
	}
	require.Equal(t, int32(1), atomic.LoadInt32(&mints),
		"a cached token must not be re-minted on every call")
}

func TestListPullRequestsParsesTheAPIShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
		case "/repos/acme/widgets/pulls":
			require.Equal(t, "Bearer stub-installation-token", r.Header.Get("Authorization"))
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": 42, "title": "Fix auth", "state": "closed", "draft": false,
				"body": "closes ENG-7", "additions": 10, "deletions": 2,
				"html_url":   "https://github.com/acme/widgets/pull/42",
				"merged_at":  "2026-09-01T10:00:00Z",
				"created_at": "2026-08-31T10:00:00Z",
				"updated_at": "2026-09-01T10:00:00Z",
				"user":       map[string]any{"login": "sabari"},
				"head":       map[string]any{"ref": "sabari/eng-7-fix-auth"},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	prs, err := c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.NoError(t, err)
	require.Len(t, prs, 1)
	require.Equal(t, 42, prs[0].Number)
	require.Equal(t, "merged", prs[0].State,
		"a closed PR with merged_at set must normalise to merged")
	require.Equal(t, "sabari/eng-7-fix-auth", prs[0].HeadRef)
	require.Equal(t, "sabari", prs[0].AuthorLogin)
}

func TestPaginationFollowsLinkHeaders(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		page := r.URL.Query().Get("page")
		if page == "" || page == "1" {
			w.Header().Set("Link", `<`+srv.URL+`/repos/acme/widgets/pulls?page=2>; rel="next"`)
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": 1, "title": "One", "state": "open",
				"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
				"user": map[string]any{"login": "a"}, "head": map[string]any{"ref": "b1"}}})
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{{
			"number": 2, "title": "Two", "state": "open",
			"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
			"user": map[string]any{"login": "a"}, "head": map[string]any{"ref": "b2"}}})
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	prs, err := c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.NoError(t, err)
	require.Len(t, prs, 2, "a second page must not be silently dropped")
}

func TestRateLimitIsReportedNotSwallowed(t *testing.T) {
	reset := time.Now().Add(30 * time.Minute)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	_, err = c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.ErrorIs(t, err, github.ErrRateLimited)
}
