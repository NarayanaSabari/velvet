package worker_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// The feed has to name the issue a PR was attached to and credit the person
// who opened it. Both were missing, so the row read "Someone attached PR #42
// to an issue", which tells a reader nothing they can act on. Only rendering
// the page revealed it; the API tests asserted the link existed, never how it
// would read.
func TestAttachedPRActivityNamesTheIssueAndItsAuthor(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	var key string
	var actorID *string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT metadata->>'key', actor_id::text
		FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbAttachedPR, issue.ID).Scan(&key, &actorID))

	require.Equal(t, issue.Key, key,
		"the feed must name the issue, not say 'an issue'")
	require.NotNil(t, actorID,
		"the PR author is a member here, so the row must credit them rather than 'Someone'")
	require.Equal(t, f.User.ID.String(), *actorID)
}
