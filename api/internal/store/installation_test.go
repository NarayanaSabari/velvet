package store_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func installationClaim(t *testing.T, f *testutil.Fixture, workspace uuid.UUID, id int64) store.GitHubAuthorization {
	t.Helper()
	setup, err := f.Store.CreateGitHubSetup(t.Context(), f.Token, f.User.ID, workspace)
	require.NoError(t, err)
	state, _, err := f.Store.StartGitHubInstallationAuthorization(t.Context(), setup, f.Token, f.User.ID, id)
	require.NoError(t, err)
	claim, err := f.Store.ClaimGitHubAuthorization(t.Context(), state, f.Token, f.User.ID, "installation")
	require.NoError(t, err)
	claim.Verifier = ""
	return claim
}

func verifiedInstallation(id int64) github.VerifiedInstallation {
	return github.VerifiedInstallation{ID: id, AccountID: 42, AccountLogin: "acme", AccountType: "Organization"}
}

// Without workspace and installation serialization, both competing owners can receive success receipts.
func TestBindInstallationConcurrency(t *testing.T) {
	for _, mode := range []string{"different-workspaces", "different-installations", "same-binding"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ws2, id2 := f.WorkspaceID, int64(99)
			if mode == "different-workspaces" {
				require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO workspace(name,slug) VALUES ('Other','other') RETURNING id`).Scan(&ws2))
				_, err := f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'admin')`, ws2, f.User.ID)
				require.NoError(t, err)
			}
			if mode == "different-installations" {
				id2 = 100
			}
			claims := []store.GitHubAuthorization{installationClaim(t, f, f.WorkspaceID, 99), installationClaim(t, f, ws2, id2)}
			var wg sync.WaitGroup
			results := make(chan error, 2)
			start := make(chan struct{})
			for _, claim := range claims {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					results <- f.Store.BindInstallation(context.Background(), claim, verifiedInstallation(claim.CandidateInstallationID))
				}()
			}
			close(start)
			wg.Wait()
			close(results)
			successes := 0
			for err := range results {
				if err == nil {
					successes++
				} else {
					require.ErrorIs(t, err, store.ErrInstallationConflict)
				}
			}
			expected := 1
			if mode == "same-binding" {
				expected = 2
			}
			require.Equal(t, expected, successes)
			var receipts, jobs, bindings int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM github_authorization_state WHERE completed_at IS NOT NULL),(SELECT count(*) FROM job),(SELECT count(*) FROM github_installation WHERE workspace_id IS NOT NULL)`).Scan(&receipts, &jobs, &bindings))
			require.Equal(t, expected, receipts)
			require.Equal(t, expected, jobs)
			require.Equal(t, 1, bindings)
			var payload []byte
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT payload FROM job ORDER BY id LIMIT 1`).Scan(&payload))
			var job store.InstallationSync
			require.NoError(t, json.Unmarshal(payload, &job))
			require.Equal(t, int64(1), job.Generation)
		})
	}
}

func TestBindInstallationDemotedAndMismatchedEvidence(t *testing.T) {
	for _, mode := range []string{"demoted", "mismatched"} {
		t.Run(mode, func(t *testing.T) {
			f := testutil.NewFixture(t)
			a := installationClaim(t, f, f.WorkspaceID, 99)
			evidence := verifiedInstallation(99)
			expected := store.ErrForbidden
			if mode == "demoted" {
				_, err := f.Pool.Exec(t.Context(), `UPDATE membership SET role='member' WHERE user_id=$1`, f.User.ID)
				require.NoError(t, err)
			} else {
				evidence.ID = 100
				expected = store.ErrNotFound
			}
			require.ErrorIs(t, f.Store.BindInstallation(t.Context(), a, evidence), expected)
			var n int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM github_installation)+(SELECT count(*) FROM job)+(SELECT count(*) FROM github_setup_state WHERE completed_at IS NOT NULL)`).Scan(&n))
			require.Zero(t, n)
		})
	}
}

func TestInstallationSyncOwnershipAndReinstall(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	pr := testutil.InsertPullRequest(t, f, 7, "Historical PR", "open")
	issue := testutil.CreateIssue(t, f, "Historical issue")
	comment, err := f.Store.CreateComment(ctx, store.CreateCommentInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Body: "Historical discussion"})
	require.NoError(t, err)
	require.NoError(t, f.Store.ManualLink(ctx, f.WorkspaceID, issue.ID, pr.ID, f.User.ID))
	_, err = f.Pool.Exec(ctx, `UPDATE repo SET disconnected_at=now(),synced_at=now()-interval '1 day'`)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `UPDATE github_installation SET deleted_at=now(),workspace_id=$1`, f.WorkspaceID)
	require.NoError(t, err)
	a := installationClaim(t, f, f.WorkspaceID, 100)
	require.NoError(t, f.Store.BindInstallation(ctx, a, verifiedInstallation(100)))
	job := store.InstallationSync{InstallationID: 100, WorkspaceID: f.WorkspaceID, Generation: 1}
	require.NoError(t, f.Store.ApplyInstallationRepos(ctx, job, []github.Repository{{ID: 555, Owner: "acme", Name: "renamed", DefaultBranch: "main"}}))
	repo, err := f.Store.RepoByGitHubID(ctx, 555)
	require.NoError(t, err)
	require.Equal(t, pr.RepoID, repo.ID)
	require.Equal(t, int64(100), repo.InstallationID)
	require.NotNil(t, repo.SyncedAt)
	var connected bool
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT disconnected_at IS NULL FROM repo WHERE id=$1`, repo.ID).Scan(&connected))
	require.True(t, connected)
	evidence, err := f.Store.EvidenceForIssue(ctx, f.WorkspaceID, issue.ID)
	require.NoError(t, err)
	require.Len(t, evidence.PullRequests, 1)
	var body string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT body FROM comment WHERE id=$1 AND target_id=$2`, comment.ID, issue.ID).Scan(&body))
	require.Equal(t, "Historical discussion", body)
	var foreign uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Foreign','foreign') RETURNING id`).Scan(&foreign))
	_, err = f.Store.LinkRepo(ctx, store.LinkRepoInput{WorkspaceID: foreign, InstallationID: 101, GitHubID: 999, Owner: "private", Name: "secret"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `UPDATE repo SET disconnected_at=now() WHERE github_id=999`)
	require.NoError(t, err)
	require.ErrorIs(t, f.Store.ApplyInstallationRepos(ctx, job, []github.Repository{{ID: 777, Owner: "acme", Name: "new"}, {ID: 999, Owner: "acme", Name: "stolen"}}), store.ErrRepositoryConflict)
	_, err = f.Store.RepoByGitHubID(ctx, 777)
	require.ErrorIs(t, err, store.ErrNotFound)
	foreignRepo, err := f.Store.RepoByGitHubID(ctx, 999)
	require.NoError(t, err)
	require.Equal(t, foreign, foreignRepo.WorkspaceID)
	require.NoError(t, f.Store.RequestInstallationSync(ctx, f.WorkspaceID, f.User.ID))
	require.ErrorIs(t, f.Store.ApplyInstallationRepos(ctx, job, []github.Repository{{ID: 778, Owner: "acme", Name: "stale"}}), store.ErrStaleInstallationSync)
}

// Failure to enqueue must not leave a usable installation or either success receipt.
func TestBindInstallationQueueFailureRollsBack(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	a := installationClaim(t, f, f.WorkspaceID, 99)
	_, err := f.Pool.Exec(ctx, `CREATE FUNCTION reject_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'queue unavailable'; END $$; CREATE TRIGGER reject_sync_job BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION reject_sync_job()`)
	require.NoError(t, err)
	require.Error(t, f.Store.BindInstallation(ctx, a, verifiedInstallation(99)))
	var n int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_installation)+(SELECT count(*) FROM job)+(SELECT count(*) FROM github_authorization_state WHERE completed_at IS NOT NULL)+(SELECT count(*) FROM github_setup_state WHERE completed_at IS NOT NULL)`).Scan(&n))
	require.Zero(t, n)
}

func TestInstallationSyncStatusIsSanitized(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	require.NoError(t, f.Store.BindInstallation(ctx, installationClaim(t, f, f.WorkspaceID, 99), verifiedInstallation(99)))
	for _, tc := range []struct{ query, status, code string }{
		{`UPDATE github_installation SET repos_synced_at=now()`, "connected", ""},
		{`UPDATE github_installation SET sync_error='provider-secret'`, "error", "sync_failed"},
		{`UPDATE github_installation SET sync_error='repository_conflict'`, "error", "repository_conflict"},
		{`UPDATE github_installation SET suspended_at=now()`, "suspended", ""},
		{`UPDATE github_installation SET deleted_at=now()`, "disconnected", ""},
	} {
		_, err := f.Pool.Exec(ctx, tc.query)
		require.NoError(t, err)
		status, err := f.Store.GitHubStatus(ctx, f.WorkspaceID)
		require.NoError(t, err)
		require.Equal(t, tc.status, status.Status)
		if tc.code == "" {
			require.Nil(t, status.Error)
		} else {
			require.Equal(t, tc.code, *status.Error)
		}
	}
}

func TestInstallationSyncLegacyVerificationGate(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	_, err := f.Pool.Exec(ctx, `INSERT INTO github_installation(id,account_login,workspace_id) VALUES (99,'acme',$1)`, f.WorkspaceID)
	require.NoError(t, err)
	require.ErrorIs(t, f.Store.RequestInstallationSync(ctx, f.WorkspaceID, f.User.ID), store.ErrVerificationRequired)
	require.NoError(t, f.Store.RequestInstallationSyncForEvent(ctx, 99))
	require.NoError(t, f.Store.ScheduleInstallationSyncs(ctx))
	var n int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM job`).Scan(&n))
	require.Zero(t, n)
	require.ErrorIs(t, f.Store.ApplyInstallationRepos(ctx, store.InstallationSync{InstallationID: 99, WorkspaceID: f.WorkspaceID}, []github.Repository{{ID: 555, Owner: "acme", Name: "hidden"}}), store.ErrStaleInstallationSync)
}
