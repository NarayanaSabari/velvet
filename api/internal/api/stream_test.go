package api_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
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

func TestStreamPublishesCreatedSprintAndMilestone(t *testing.T) {
	f := testutil.NewFixture(t)
	projectID := f.SprintProject()
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
	reader := bufio.NewReader(resp.Body)
	for _, want := range []string{": connected\n", "\n"} {
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, want, line)
	}
	assertActivity := func(verb string, targetID uuid.UUID) {
		t.Helper()
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, "event: activity\n", line)
		line, err = reader.ReadString('\n')
		require.NoError(t, err)
		var activity store.Activity
		require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &activity))
		require.Equal(t, verb, activity.Verb)
		require.Equal(t, targetID, activity.TargetID)
		line, err = reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, "\n", line)
	}
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Streamed sprint", "project_id": projectID.String(),
		"starts_on": "2026-09-01", "ends_on": "2026-09-30",
	})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var sprint store.Sprint
	f.DecodeInto(rec, &sprint)
	assertActivity(store.VerbCreatedSprint, sprint.ID)
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", map[string]any{"name": "Streamed milestone"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var milestone store.Milestone
	f.DecodeInto(rec, &milestone)
	assertActivity(store.VerbCreatedMilestone, milestone.ID)
}

func TestStreamRefreshesSilentIssueEditsWithoutLeakingWorkspaces(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Original title")
	var otherWorkspace uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO workspace(name,slug,issue_prefix) VALUES('Other','other','OTH') RETURNING id`).Scan(&otherWorkspace))
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')`, otherWorkspace, f.User.ID)
	require.NoError(t, err)
	since, err := f.Store.LatestActivityID(t.Context(), f.WorkspaceID)
	require.NoError(t, err)
	srv := httptest.NewServer(f.Handler)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	openStream := func(ctx context.Context, slug string) *bufio.Reader {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/w/"+slug+"/stream", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { resp.Body.Close() })
		require.Equal(t, http.StatusOK, resp.StatusCode)
		reader := bufio.NewReader(resp.Body)
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, ": connected\n", line)
		line, err = reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, "\n", line)
		return reader
	}
	reader := openStream(ctx, "lab")
	otherCtx, otherCancel := context.WithTimeout(ctx, 2*time.Second)
	defer otherCancel()
	other := openStream(otherCtx, "other")
	for _, field := range []string{"title", "description"} {
		rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key, map[string]any{field: "Updated " + field})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		for _, want := range []string{"event: refresh\n", "data: {}\n", "\n"} {
			line, err := reader.ReadString('\n')
			require.NoError(t, err)
			require.Equal(t, want, line)
		}
	}
	updated, err := f.Store.GetIssueByKey(t.Context(), f.WorkspaceID, issue.Key)
	require.NoError(t, err)
	require.Equal(t, "Updated title", updated.Title)
	require.Equal(t, "Updated description", updated.Description)
	after, err := f.Store.LatestActivityID(t.Context(), f.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, since, after, "cache refresh must not fabricate business activity")
	line, err := other.ReadString('\n')
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Empty(t, line, "another workspace must not receive the refresh")
}

// A real established connection must close before emitting either an event or
// the production heartbeat after the viewer loses their membership.
func TestStreamStopsAfterMembershipRemoval(t *testing.T) {
	for _, trigger := range []string{"activity", "refresh", "heartbeat"} {
		t.Run(trigger, func(t *testing.T) {
			f := testutil.NewFixture(t)
			issue := testutil.CreateIssue(t, f, "Original")
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
				// External membership removal emits no broker event. Revalidate
				// on the next refresh or, without a mutation, the heartbeat.
				_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE id=$1`, id)
				require.NoError(t, err)
				if trigger == "refresh" {
					r := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key, map[string]any{"title": "Updated"})
					require.Equal(t, http.StatusOK, r.Code, r.Body.String())
				}
			}
			line, err = reader.ReadString('\n')
			require.ErrorIs(t, err, io.EOF, "received after removal: %q", line)
			require.Empty(t, line)
		})
	}
}
