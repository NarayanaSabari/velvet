package api_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// writerBodyGate observes the handler's first body read, which occurs after
// the real workspace and role middleware. Holding that read models a slow
// in-flight HTTP request without guessing when authentication has completed.
type writerBodyGate struct {
	io.ReadCloser
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *writerBodyGate) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.release })
	return b.ReadCloser.Read(p)
}

func TestWriterRevocationInFlightHTTP(t *testing.T) {
	for _, revoke := range []string{"demotion", "removal"} {
		t.Run(revoke, func(t *testing.T) {
			f := testutil.NewFixture(t)
			issue := testutil.CreateIssue(t, f, "Original title")
			actor, err := f.Store.UpsertUserByEmail(t.Context(), "writer@example.com")
			require.NoError(t, err)
			var membershipID uuid.UUID
			require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member') RETURNING id`, f.WorkspaceID, actor.ID).Scan(&membershipID))
			token, err := f.Store.CreateAPIToken(t.Context(), actor.ID, "race")
			require.NoError(t, err)

			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") == "Bearer "+token {
					r.Body = &writerBodyGate{ReadCloser: r.Body, entered: entered, release: release}
				}
				f.Handler.ServeHTTP(w, r)
			}))
			defer srv.Close()
			defer unblock()
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPatch, srv.URL+"/api/v1/w/lab/issues/"+issue.Key, strings.NewReader(`{"title":"After revocation"}`))
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			type result struct {
				response *http.Response
				err      error
			}
			done := make(chan result, 1)
			go func() { response, err := srv.Client().Do(req); done <- result{response, err} }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("handler never reached the body read after authorization")
			}
			path := "/api/v1/w/lab/memberships/" + membershipID.String()
			if revoke == "demotion" {
				rec := f.Do(http.MethodPatch, path, map[string]string{"role": "viewer"})
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			} else {
				rec := f.Do(http.MethodDelete, path, nil)
				require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
			}
			unblock()
			got := <-done
			require.NoError(t, got.err)
			defer got.response.Body.Close()
			body, err := io.ReadAll(got.response.Body)
			require.NoError(t, err)
			updated, err := f.Store.GetIssueByKey(t.Context(), f.WorkspaceID, issue.Key)
			require.NoError(t, err)
			t.Logf("revocation=%s HTTP=%d persisted_title=%q response=%s", revoke, got.response.StatusCode, updated.Title, body)
			require.Equal(t, http.StatusForbidden, got.response.StatusCode, string(body))
			require.Equal(t, "Original title", updated.Title)
		})
	}
}

func TestWriterFamiliesRevocationInFlightHTTP(t *testing.T) {
	for _, family := range []string{"comment", "project", "sprint", "milestone", "label", "evidence"} {
		for _, revoke := range []string{"demotion", "removal"} {
			t.Run(family+"/"+revoke, func(t *testing.T) {
				f := testutil.NewFixture(t)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				defer cancel()
				issue := testutil.CreateIssue(t, f, "Original")
				projectID := f.SprintProject()
				sprint, err := f.Store.CreateSprint(ctx, store.CreateSprintInput{WorkspaceID: f.WorkspaceID, ProjectID: projectID, ActorID: f.User.ID, Name: "Sprint", StartsOn: "2026-01-01", EndsOn: "2026-01-15"})
				require.NoError(t, err)
				pr := testutil.InsertPullRequest(t, f, 2, "PR", "open")
				actor, err := f.Store.UpsertUserByEmail(ctx, "writer@example.com")
				require.NoError(t, err)
				var membershipID uuid.UUID
				require.NoError(t, f.Pool.QueryRow(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member') RETURNING id`, f.WorkspaceID, actor.ID).Scan(&membershipID))
				token, err := f.Store.CreateAPIToken(ctx, actor.ID, "slow-writer")
				require.NoError(t, err)
				path, body := "", ""
				switch family {
				case "comment":
					path, body = "/issues/"+issue.Key+"/comments", `{"body":"Forbidden comment"}`
				case "project":
					path, body = "/projects", `{"key":"forbidden","name":"Forbidden project"}`
				case "sprint":
					path, body = "/sprints", `{"project_id":"`+projectID.String()+`","name":"Forbidden sprint","starts_on":"2026-02-01","ends_on":"2026-02-15"}`
				case "milestone":
					path, body = "/sprints/"+sprint.ID.String()+"/milestones", `{"name":"Forbidden milestone"}`
				case "label":
					path, body = "/labels", `{"name":"Forbidden label","color":"#112233"}`
				case "evidence":
					path, body = "/issues/"+issue.Key+"/evidence", `{"reference":"acme/widgets#2"}`
				}
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				unblock := func() { once.Do(func() { close(release) }) }
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					r.Body = &writerBodyGate{ReadCloser: r.Body, entered: entered, release: release}
					f.Handler.ServeHTTP(w, r)
				}))
				defer srv.Close()
				defer unblock()
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/api/v1/w/lab"+path, strings.NewReader(body))
				require.NoError(t, err)
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", "application/json")
				type result struct {
					response *http.Response
					err      error
				}
				done := make(chan result, 1)
				go func() { response, err := srv.Client().Do(req); done <- result{response, err} }()
				select {
				case <-entered:
				case <-ctx.Done():
					t.Fatal("handler did not read body after authorization")
				}
				if revoke == "demotion" {
					_, err = f.Store.UpdateWorkspaceMembershipRole(ctx, f.WorkspaceID, membershipID, f.User.ID, "viewer")
				} else {
					err = f.Store.RemoveWorkspaceMembership(ctx, f.WorkspaceID, membershipID, f.User.ID)
				}
				require.NoError(t, err)
				unblock()
				got := <-done
				require.NoError(t, got.err)
				defer got.response.Body.Close()
				responseBody, err := io.ReadAll(got.response.Body)
				require.NoError(t, err)
				t.Logf("family=%s revocation=%s HTTP=%d", family, revoke, got.response.StatusCode)
				require.Equal(t, http.StatusForbidden, got.response.StatusCode, string(responseBody))
				var count int
				switch family {
				case "comment":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM comment WHERE workspace_id=$1`, f.WorkspaceID).Scan(&count)
				case "project":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM project WHERE workspace_id=$1 AND key='forbidden'`, f.WorkspaceID).Scan(&count)
				case "sprint":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM sprint WHERE workspace_id=$1 AND name='Forbidden sprint'`, f.WorkspaceID).Scan(&count)
				case "milestone":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM milestone WHERE workspace_id=$1`, f.WorkspaceID).Scan(&count)
				case "label":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM label WHERE workspace_id=$1`, f.WorkspaceID).Scan(&count)
				case "evidence":
					err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM pr_link WHERE pull_request_id=$1`, pr.ID).Scan(&count)
				}
				require.NoError(t, err)
				require.Zero(t, count)
				var actorActivity int
				require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM activity WHERE actor_id=$1`, actor.ID).Scan(&actorActivity))
				require.Zero(t, actorActivity, "denied request must not append audit rows")
			})
		}
	}
}
