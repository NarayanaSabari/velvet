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

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
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

// A real established connection must close before emitting either an event or
// the production heartbeat after the viewer loses their membership.
func TestStreamStopsAfterMembershipRemoval(t *testing.T) {
	for _, trigger := range []string{"activity", "heartbeat"} {
		t.Run(trigger, func(t *testing.T) {
			f := testutil.NewFixture(t)
			u, err := f.Store.UpsertUserByEmail(t.Context(), "viewer@example.com")
			require.NoError(t, err)
			var id uuid.UUID
			require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'viewer') RETURNING id`, f.WorkspaceID, u.ID).Scan(&id))
			token, err := f.Store.CreateSession(t.Context(), u.ID, time.Hour)
			require.NoError(t, err)
			srv := httptest.NewServer(f.Handler)
			defer srv.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/v1/w/lab/stream", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, 200, resp.StatusCode)
			reader := bufio.NewReader(resp.Body)
			line, err := reader.ReadString('\n')
			require.NoError(t, err)
			require.Equal(t, ": connected\n", line)
			_, err = reader.ReadString('\n')
			require.NoError(t, err)
			if trigger == "activity" {
				r := f.Do("DELETE", "/api/v1/w/lab/memberships/"+id.String(), nil)
				require.Equal(t, 204, r.Code, r.Body.String())
			} else {
				// External membership removal emits no broker event, leaving the
				// heartbeat as the only trigger for revalidation.
				_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE id=$1`, id)
				require.NoError(t, err)
			}
			line, err = reader.ReadString('\n')
			require.ErrorIs(t, err, io.EOF, "received after removal: %q", line)
			require.Empty(t, line)
		})
	}
}
