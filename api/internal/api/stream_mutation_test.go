package api_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestStreamRefreshesSuccessfulWorkspaceMutationsOnly(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Evidence")
	comment, err := f.Store.CreateComment(t.Context(), store.CreateCommentInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Body: "Original",
	})
	require.NoError(t, err)
	label, err := f.Store.CreateLabel(t.Context(), f.WorkspaceID, f.User.ID, "Existing", "#111111")
	require.NoError(t, err)
	pr := testutil.InsertPullRequest(t, f, 42, "Attached", "open")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))
	suggestedPR := testutil.InsertPullRequest(t, f, 43, "Suggested", "open")
	suggestionID := suggest(t, f, store.SuggestionPullRequest, suggestedPR.ID, issue.ID)
	var otherWorkspace uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO workspace(name,slug,issue_prefix) VALUES('Other','other','OTH') RETURNING id`).Scan(&otherWorkspace))
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')`, otherWorkspace, f.User.ID)
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
		for _, want := range []string{": connected\n", "\n"} {
			line, err := reader.ReadString('\n')
			require.NoError(t, err)
			require.Equal(t, want, line)
		}
		return reader
	}
	reader := openStream(ctx, "lab")
	otherCtx, otherCancel := context.WithTimeout(ctx, 3*time.Second)
	defer otherCancel()
	other := openStream(otherCtx, "other")
	commentPath := "/api/v1/w/lab/comments/" + comment.ID.String()
	labelPath := "/api/v1/w/lab/labels/" + label.ID.String()
	issueLabelsPath := "/api/v1/w/lab/issues/" + issue.Key + "/labels"
	prPath := "/api/v1/w/lab/issues/" + issue.Key + "/prs/" + pr.ID.String()
	suggestionPath := "/api/v1/w/lab/suggestions/" + suggestionID.String() + "/dismiss"
	type mutation struct {
		name, method, path string
		body               any
		status             int
	}
	for _, step := range []mutation{
		{"comment update", http.MethodPatch, commentPath, map[string]any{"body": "Edited"}, http.StatusOK},
		{"comment delete", http.MethodDelete, commentPath, nil, http.StatusNoContent},
		{"label create", http.MethodPost, "/api/v1/w/lab/labels", map[string]any{"name": "New"}, http.StatusCreated},
		{"label assign", http.MethodPut, issueLabelsPath, map[string]any{"label_ids": []string{label.ID.String()}}, http.StatusOK},
		{"label delete", http.MethodDelete, labelPath, nil, http.StatusNoContent},
		{"PR detach", http.MethodDelete, prPath, nil, http.StatusNoContent},
		{"suggestion dismiss", http.MethodPost, suggestionPath, nil, http.StatusNoContent},
		{"suggestion settings", http.MethodPatch, "/api/v1/w/lab/suggestions/settings", map[string]any{"enabled": false}, http.StatusOK},
	} {
		rec := f.Do(step.method, step.path, step.body)
		require.Equal(t, step.status, rec.Code, "%s: %s", step.name, rec.Body.String())
		for _, want := range []string{"event: refresh\n", "data: {}\n", "\n"} {
			line, err := reader.ReadString('\n')
			require.NoError(t, err, step.name)
			require.Equal(t, want, line, step.name)
		}
	}

	// Observe rejections separately so a false event cannot mask a missing success event.
	rejectedCtx, rejectedCancel := context.WithTimeout(ctx, time.Second)
	defer rejectedCancel()
	rejected := openStream(rejectedCtx, "lab")
	for _, step := range []mutation{
		{"comment update", http.MethodPatch, commentPath, map[string]any{"body": "Edited again"}, http.StatusNotFound},
		{"comment delete", http.MethodDelete, commentPath, nil, http.StatusNotFound},
		{"label create", http.MethodPost, "/api/v1/w/lab/labels", map[string]any{"name": "New"}, http.StatusConflict},
		{"label assign", http.MethodPut, issueLabelsPath, map[string]any{"label_ids": []string{label.ID.String()}}, http.StatusBadRequest},
		{"label delete", http.MethodDelete, labelPath, nil, http.StatusNotFound},
		{"PR detach", http.MethodDelete, prPath, nil, http.StatusNotFound},
		{"suggestion dismiss", http.MethodPost, suggestionPath, nil, http.StatusConflict},
		{"suggestion settings", http.MethodPatch, "/api/v1/w/lab/suggestions/settings", map[string]any{}, http.StatusBadRequest},
	} {
		rec := f.Do(step.method, step.path, step.body)
		require.Equal(t, step.status, rec.Code, "%s: %s", step.name, rec.Body.String())
	}
	line, err := rejected.ReadString('\n')
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Empty(t, line, "failed writes must not publish events")
	line, err = other.ReadString('\n')
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Empty(t, line, "mutations must not publish to another workspace")
	after, err := f.Store.LatestActivityID(t.Context(), f.WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, since, after, "refresh signals must not fabricate activity records")
}
