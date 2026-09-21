package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// pushCommit records a push delivery and drains the queue, which is the same
// path a real webhook takes. Attribution is decided there rather than in a
// store call a test could make directly.
func pushCommit(t *testing.T, f *testutil.Fixture, branch, sha, message string) {
	t.Helper()
	payload := map[string]any{
		"installation": map[string]any{"id": 99},
		"ref":          "refs/heads/" + branch,
		"repository": map[string]any{
			"id": 555, "name": "widgets", "default_branch": "main",
			"owner": map[string]any{"login": "acme"},
		},
		"commits": []map[string]any{{
			"id": sha, "message": message,
			"url":       "https://github.com/acme/widgets/commit/" + sha,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"author":    map[string]any{"username": "sabari", "name": "Sabari"},
		}},
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	_, err = f.Store.RecordDelivery(t.Context(), "delivery-"+sha, "push", body)
	require.NoError(t, err)

	w := testutil.NewWorker(t, f, testutil.GitHubStub(t))
	for {
		did, err := w.ProcessOnce(t.Context())
		require.NoError(t, err)
		if !did {
			return
		}
	}
}

// A branch that names no issue is the ordinary case for agent-driven work.
// The commit must still land somewhere a person can find it later, which is
// what mapping the repository to a project provides.
func TestACommitOnAKeylessBranchIsAttributableToItsProject(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/repos/"+repo.ID.String()+"/project",
		map[string]any{"project_id": project.ID.String()})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	sha := strings.Repeat("a", 40)
	pushCommit(t, f, "sabari/fix-the-thing", sha, "Fix the thing")

	// The commit is recorded with no issue, which is correct: the branch named
	// none and commit messages are deliberately never searched.
	var issueID *string
	var projectKey string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT c.issue_id::text, p.key
		FROM commit_ref c JOIN repo r ON r.id = c.repo_id
		JOIN project p ON p.id = r.project_id
		WHERE c.sha = $1`, sha).Scan(&issueID, &projectKey))
	require.Nil(t, issueID, "a keyless branch must not invent an issue")
	require.Equal(t, "velvet", projectKey,
		"the commit still has a home, through the repository's project")
}

func TestEvidenceAttachesByPullRequestURLAndShorthand(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	pr := testutil.InsertPullRequest(t, f, 42, "Ship it", "open")

	for _, reference := range []string{
		"https://github.com/acme/widgets/pull/42",
		"https://github.com/acme/widgets/pull/42/files",
		"acme/widgets#42",
	} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
			map[string]any{"reference": reference})
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", reference, rec.Body.String())

		var ref store.EvidenceRef
		f.DecodeInto(rec, &ref)
		require.Equal(t, "pull_request", ref.Kind)
		require.Equal(t, pr.ID, ref.ID)
	}

	// Re-attaching the same PR must read as one attachment, not several.
	var links int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM pr_link WHERE issue_id = $1`, issue.ID).Scan(&links))
	require.Equal(t, 1, links)
}

func TestEvidenceAttachesByCommitSHA(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	sha := strings.Repeat("b", 40)
	pushCommit(t, f, "main", sha, "Unrelated work")

	for _, reference := range []string{
		sha,
		sha[:7],
		"https://github.com/acme/widgets/commit/" + sha,
	} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
			map[string]any{"reference": reference})
		require.Equal(t, http.StatusCreated, rec.Code, "%s: %s", reference, rec.Body.String())

		var ref store.EvidenceRef
		f.DecodeInto(rec, &ref)
		require.Equal(t, "commit", ref.Kind)
		require.Equal(t, sha, ref.SHA)
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var evidence store.Evidence
	f.DecodeInto(rec, &evidence)
	require.Len(t, evidence.Commits, 1, "re-attaching must not duplicate the commit")

	// One attachment records one activity row, however many times it was sent.
	var attaches int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1`, store.VerbAttachedCommit).Scan(&attaches))
	require.Equal(t, 1, attaches)
}

// Inventing a row for an unsynced PR would put unverified evidence into the
// record of someone's work, so an unknown reference must fail.
func TestAttachingUnsyncedOrForeignEvidenceFails(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	for _, reference := range []string{
		"https://github.com/acme/widgets/pull/999",
		"acme/widgets#999",
		strings.Repeat("f", 40),
		"not a reference at all",
		"",
	} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
			map[string]any{"reference": reference})
		require.Contains(t, []int{http.StatusNotFound, http.StatusBadRequest}, rec.Code,
			"%q must not resolve: %s", reference, rec.Body.String())
	}

	// A PR that exists, but in another workspace, must not be reachable here.
	testutil.InsertForeignPullRequest(t, f, 7, "Another organisation's work")
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
		map[string]any{"reference": "other/repo#7"})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"another workspace's pull request must not be attachable here")
}

func TestAnAmbiguousShortSHAIsRejectedRatherThanGuessed(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// Two commits sharing a prefix: attaching the wrong proof of work is worse
	// than attaching none, so the abbreviation must be refused.
	shared := "abc1234"
	first := shared + strings.Repeat("1", 33)
	second := shared + strings.Repeat("2", 33)
	pushCommit(t, f, "main", first, "First")
	pushCommit(t, f, "main", second, "Second")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
		map[string]any{"reference": shared})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	// The unabbreviated sha is unambiguous and still works.
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
		map[string]any{"reference": first})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

// The rule the whole product rests on: proof that work happened is never a
// decision that the work is finished.
func TestAttachingEvidenceNeverChangesIssueStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it", "status": "in_progress"})
	testutil.LinkRepo(t, f, 555, "acme", "widgets")
	pr := testutil.InsertPullRequest(t, f, 42, "Ship it", "open")

	sha := strings.Repeat("c", 40)
	pushCommit(t, f, "main", sha, "Some work")

	for _, reference := range []string{
		fmt.Sprintf("acme/widgets#%d", pr.Number),
		sha,
	} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/evidence",
			map[string]any{"reference": reference})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

		var status string
		require.NoError(t, f.Pool.QueryRow(t.Context(),
			`SELECT status::text FROM issue WHERE id = $1`, issue.ID).Scan(&status))
		require.Equal(t, "in_progress", status,
			"attaching %q must not decide the work is finished", reference)
	}

	// Merging is the strongest signal GitHub can send, and it still must not
	// move the ticket. Only the person decides that.
	_, err := f.Pool.Exec(t.Context(),
		`UPDATE pull_request SET state = 'merged', merged_at = now() WHERE id = $1`, pr.ID)
	require.NoError(t, err)

	var status string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT status::text FROM issue WHERE id = $1`, issue.ID).Scan(&status))
	require.Equal(t, "in_progress", status, "a merge must never move the ticket")
}
