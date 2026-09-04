package api_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestStreamDeliversNewActivity(t *testing.T) {
	f := testutil.NewFixture(t)

	srv := httptest.NewServer(f.Handler)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/w/lab/stream", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/event-stream", strings.Split(resp.Header.Get("Content-Type"), ";")[0])

	reader := bufio.NewReader(resp.Body)
	// The server sends a comment line immediately so the client knows it is
	// connected rather than waiting on a proxy buffer.
	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(line, ":"), "got %q", line)

	go func() {
		time.Sleep(200 * time.Millisecond)
		createIssue(t, f, map[string]any{"title": "Streamed"})
	}()

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		if strings.HasPrefix(line, "data:") && strings.Contains(line, "created_issue") {
			return
		}
	}
	t.Fatal("no activity event arrived on the stream")
}

func TestStreamRequiresMembership(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/w/lab/stream", nil)
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
