package worker_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestStalePullRequestDoesNotLinkIncomingReferences(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	accepted := testutil.CreateIssue(t, f, "Accepted reference")
	branch := testutil.CreateIssue(t, f, "Stale branch reference")
	title := testutil.CreateIssue(t, f, "Stale title reference")
	body := testutil.CreateIssue(t, f, "Stale body reference")
	now := time.Now().UTC().Truncate(time.Second)
	pr, err := f.Store.UpsertPullRequest(t.Context(), store.UpsertPRInput{
		WorkspaceID: f.WorkspaceID, RepoID: repo.ID, Number: 42,
		Title: "Accepted title", Body: "Accepted body", HeadRef: "fix/" + accepted.Key,
		State: "merged", AuthorLogin: "sabari", GHUpdatedAt: &now,
	})
	require.NoError(t, err)
	payload, err := json.Marshal(map[string]any{
		"installation": map[string]any{"id": 99},
		"repository":   map[string]any{"id": 555},
		"pull_request": map[string]any{
			"number": 42, "state": "open", "title": "Fixes " + title.Key,
			"body": "Closes " + body.Key, "head": map[string]any{"ref": "fix/" + branch.Key},
			"updated_at": now.Add(-time.Hour).Format(time.RFC3339),
		},
	})
	require.NoError(t, err)
	for _, deliveryID := range []string{"stale-pr", "stale-pr-replay"} {
		_, err = f.Store.RecordDelivery(t.Context(), deliveryID, "pull_request", payload)
		require.NoError(t, err)
		for {
			did, err := w.ProcessOnce(t.Context())
			require.NoError(t, err)
			if !did {
				break
			}
		}
	}
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link WHERE pull_request_id=$1`, pr.ID).Scan(&count))
	require.Equal(t, 1, count, "only the stored reference may link")
	var key, source string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT i.key, l.link_source FROM pr_link l JOIN issue i ON i.id=l.issue_id WHERE l.pull_request_id=$1`, pr.ID).Scan(&key, &source))
	require.Equal(t, accepted.Key, key)
	require.Equal(t, "branch", source)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE verb=$1`, store.VerbAttachedPR).Scan(&count))
	require.Equal(t, 1, count, "replaying stale events must not add activity")
	var state, storedTitle, storedBody, head string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT state, title, body, head_ref FROM pull_request WHERE id=$1`, pr.ID).Scan(&state, &storedTitle, &storedBody, &head))
	require.Equal(t, []string{pr.State, pr.Title, pr.Body, pr.HeadRef}, []string{state, storedTitle, storedBody, head})
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM issue WHERE status <> 'backlog'`).Scan(&count))
	require.Zero(t, count, "evidence never changes issue status")
}
