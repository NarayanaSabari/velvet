package worker_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

// deliver stores a fixture payload as a delivery and drains the queue, which
// is the same path a real webhook takes.
func deliver(t *testing.T, f *testutil.Fixture, w *worker.Worker, event, fixture, deliveryID string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "testdata", "github", fixture))
	require.NoError(t, err)

	_, err = f.Store.RecordDelivery(t.Context(), deliveryID, event, body)
	require.NoError(t, err)

	for {
		did, err := w.ProcessOnce(t.Context())
		require.NoError(t, err)
		if !did {
			return
		}
	}
}

func TestOpenedPRLinksToIssueByBranch(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth") // becomes ENG-1
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// The fixture's head.ref is "sabari/eng-1-fix-auth".
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	var source string
	var closing bool
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT link_source::text, closing FROM pr_link WHERE issue_id = $1`,
		issue.ID).Scan(&source, &closing))
	require.Equal(t, "branch", source)
	require.False(t, closing)
}

func TestPRNeverChangesIssueStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d2")

	var status string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT status::text FROM issue WHERE id = $1`, issue.ID).Scan(&status))
	require.Equal(t, "backlog", status,
		"merging a PR records evidence; only a human changes status")
}

func TestMergedPRRecordsAttachedActivityOnce(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d2")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbAttachedPR, issue.ID).Scan(&count))
	require.Equal(t, 1, count,
		"a second event for the same PR must not re-announce the attachment")

	var state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT state::text FROM pull_request WHERE number = 42`).Scan(&state))
	require.Equal(t, "merged", state)
}

func TestUnmatchedPRIsStoredAndListedAsUnlinked(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// No issue exists, so nothing can match.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	prs, err := f.Store.UnlinkedPullRequests(t.Context(), f.WorkspaceID, 10)
	require.NoError(t, err)
	require.Len(t, prs, 1,
		"an unmatched PR stays visible rather than vanishing")
	require.Equal(t, 42, prs[0].Number)
}

func TestDeliveryForAnUnknownRepoIsIgnoredNotFatal(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	// No repo linked at all: the delivery cannot be attributed to a workspace.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	var prs, dead int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&prs))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job WHERE dead`).Scan(&dead))
	require.Equal(t, 0, prs)
	require.Equal(t, 0, dead, "an unattributable delivery is dropped, not retried forever")
}

func TestPushRecordsCommitsAgainstTheBranchIssue(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "push", "push.json", "d1")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM commit_ref WHERE issue_id = $1`, issue.ID).Scan(&count))
	require.Greater(t, count, 0)
}

func TestReviewIsMirroredOntoThePR(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request_review", "pull_request_review.submitted.json", "d2")

	var reviewer, state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT reviewer_login, state FROM pr_review`).Scan(&reviewer, &state))
	require.NotEmpty(t, reviewer,
		"a reviewer's work belongs in the record too, not just the author's")
	require.NotEmpty(t, state)
}

func TestReplayingADeliveryChangesNothing(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	snapshot := func() [3]int {
		var s [3]int
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&s[0]))
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&s[1]))
		require.NoError(t, f.Pool.QueryRow(t.Context(),
			`SELECT count(*) FROM activity WHERE verb = 'attached_pr'`).Scan(&s[2]))
		return s
	}
	before := snapshot()

	// Same payload, different delivery id: GitHub does this after an outage.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d2")

	require.Equal(t, before, snapshot(), "reprocessing must be idempotent")
}

func TestOutOfOrderEventsDoNotResurrectStaleState(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// Merge arrives first, then the older "opened" event.
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d2")

	var state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT state::text FROM pull_request WHERE number = 42`).Scan(&state))
	require.Equal(t, "merged", state,
		"an older event must not overwrite newer state")
}

// stubGitHub answers the few REST calls the worker makes during these tests.
// Webhook processing should not need GitHub at all; this exists so a stray
// call fails loudly in the test rather than reaching the network.
func stubGitHub(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	t.Cleanup(srv.Close)
	return srv
}
