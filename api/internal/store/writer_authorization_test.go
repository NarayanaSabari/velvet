package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// Every public user writer must reject absent actors before changing any row.
// Valid workspace targets are used where applicable. Rejection must precede
// target and token validation, including synthetic image references.
func TestUserWritersRejectRevokedAndNilActors(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	ws := f.WorkspaceID
	issue := testutil.CreateIssue(t, f, "Original")
	projectID := f.SprintProject()
	sprint, err := f.Store.CreateSprint(ctx, store.CreateSprintInput{WorkspaceID: ws, ProjectID: projectID, ActorID: f.User.ID, Name: "Sprint", StartsOn: "2026-01-01", EndsOn: "2026-01-15"})
	require.NoError(t, err)
	milestone, err := f.Store.CreateMilestone(ctx, store.CreateMilestoneInput{WorkspaceID: ws, SprintID: sprint.ID, ActorID: f.User.ID, Name: "Milestone"})
	require.NoError(t, err)
	actor, err := f.Store.UpsertUserByEmail(ctx, "revoked@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, ws, actor.ID)
	require.NoError(t, err)
	comment, err := f.Store.CreateComment(ctx, store.CreateCommentInput{WorkspaceID: ws, ActorID: actor.ID, TargetType: "project", TargetID: projectID, Body: "Original"})
	require.NoError(t, err)
	label, err := f.Store.CreateLabel(ctx, ws, f.User.ID, "Label", "#112233")
	require.NoError(t, err)
	pr := testutil.InsertPullRequest(t, f, 1, "PR", "open")
	require.NoError(t, f.Store.ManualLink(ctx, ws, issue.ID, pr.ID, f.User.ID))
	var repoID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT repo_id FROM pull_request WHERE id=$1`, pr.ID).Scan(&repoID))
	require.NoError(t, f.Store.UpsertCommit(ctx, store.UpsertCommitInput{SHA: "synthetic", WorkspaceID: ws, RepoID: repoID, Branch: "main", CommittedAt: time.Now()}))
	var activityBefore int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM activity WHERE actor_id=$1`, actor.ID).Scan(&activityBefore))
	title := "Changed"
	writers := []struct {
		name  string
		write func(uuid.UUID) error
	}{
		{"issue/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: ws, ActorID: a, Title: title})
			return e
		}},
		{"issue/update", func(a uuid.UUID) error {
			_, e := f.Store.UpdateIssue(ctx, ws, issue.ID, a, store.IssuePatch{Title: &title})
			return e
		}},
		{"comment/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateComment(ctx, store.CreateCommentInput{WorkspaceID: ws, ActorID: a, TargetType: "issue", TargetID: issue.ID, Body: title})
			return e
		}},
		{"comment/update", func(a uuid.UUID) error { _, e := f.Store.UpdateComment(ctx, ws, comment.ID, a, title); return e }},
		{"comment/delete", func(a uuid.UUID) error { return f.Store.DeleteComment(ctx, ws, comment.ID, a) }},
		{"comment/promote", func(a uuid.UUID) error {
			_, e := f.Store.PromoteCommentToIssue(ctx, ws, comment.ID, a, title)
			return e
		}},
		{"project/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateProject(ctx, store.CreateProjectInput{WorkspaceID: ws, ActorID: a, Key: "new", Name: title})
			return e
		}},
		{"project/update", func(a uuid.UUID) error {
			_, e := f.Store.UpdateProject(ctx, ws, projectID, a, store.ProjectPatch{Name: &title})
			return e
		}},
		{"project/repo", func(a uuid.UUID) error { return f.Store.SetRepoProject(ctx, ws, repoID, a, &projectID) }},
		{"sprint/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateSprint(ctx, store.CreateSprintInput{WorkspaceID: ws, ActorID: a, ProjectID: projectID, Name: title, StartsOn: "2026-02-01", EndsOn: "2026-02-15"})
			return e
		}},
		{"sprint/activate", func(a uuid.UUID) error { _, e := f.Store.ActivateSprint(ctx, ws, sprint.ID, a); return e }},
		{"sprint/close", func(a uuid.UUID) error { _, e := f.Store.CloseSprint(ctx, ws, sprint.ID, a); return e }},
		{"milestone/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateMilestone(ctx, store.CreateMilestoneInput{WorkspaceID: ws, ActorID: a, SprintID: sprint.ID, Name: title})
			return e
		}},
		{"milestone/update", func(a uuid.UUID) error {
			_, e := f.Store.UpdateMilestone(ctx, ws, milestone.ID, a, store.MilestonePatch{Name: &title})
			return e
		}},
		{"label/create", func(a uuid.UUID) error { _, e := f.Store.CreateLabel(ctx, ws, a, "New", "#112233"); return e }},
		{"label/delete", func(a uuid.UUID) error { return f.Store.DeleteLabel(ctx, ws, label.ID, a) }},
		{"label/set", func(a uuid.UUID) error {
			_, e := f.Store.SetIssueLabels(ctx, ws, issue.ID, a, []uuid.UUID{label.ID})
			return e
		}},
		{"evidence/commit", func(a uuid.UUID) error {
			return f.Store.AttachEvidenceToIssue(ctx, ws, issue.ID, a, store.EvidenceRef{Kind: "commit", SHA: "synthetic"})
		}},
		{"evidence/pr", func(a uuid.UUID) error {
			return f.Store.AttachEvidenceToIssue(ctx, ws, issue.ID, a, store.EvidenceRef{Kind: "pull_request", ID: pr.ID})
		}},
		{"evidence/manual", func(a uuid.UUID) error { return f.Store.ManualLink(ctx, ws, issue.ID, pr.ID, a) }},
		{"image/create", func(a uuid.UUID) error {
			_, e := f.Store.CreateImage(ctx, store.ImageInput{WorkspaceID: ws, ActorID: a, TargetType: "issue", TargetID: issue.ID})
			return e
		}},
		{"image/delete", func(a uuid.UUID) error { return f.Store.DeleteImage(ctx, ws, uuid.New(), a) }},
		{"image/prepare", func(a uuid.UUID) error {
			_, e := f.Store.PrepareImageUpload(ctx, store.ImageInput{WorkspaceID: ws, ActorID: a, TargetType: "issue", TargetID: issue.ID, APITokenID: &repoID})
			return e
		}},
		{"evidence/unlink", func(a uuid.UUID) error { return f.Store.Unlink(ctx, ws, issue.ID, pr.ID, a) }},
	}
	for _, state := range []string{"viewer", "removed", "nil"} {
		t.Run(state, func(t *testing.T) {
			var a = actor.ID
			switch state {
			case "viewer":
				_, err = f.Pool.Exec(ctx, `UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, ws, a)
			case "removed":
				_, err = f.Pool.Exec(ctx, `DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2`, ws, a)
			case "nil":
				a = uuid.Nil
			}
			require.NoError(t, err)
			for _, writer := range writers {
				t.Run(writer.name, func(t *testing.T) { require.ErrorIs(t, writer.write(a), store.ErrForbidden) })
			}
		})
	}
	var activityAfter int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM activity WHERE actor_id=$1`, actor.ID).Scan(&activityAfter))
	require.Equal(t, activityBefore, activityAfter, "denied writes must not append audit rows")
	got, err := f.Store.GetIssueByKey(ctx, ws, issue.Key)
	require.NoError(t, err)
	require.Equal(t, "Original", got.Title)
	gotComment, err := f.Store.GetComment(ctx, ws, comment.ID)
	require.NoError(t, err)
	require.Equal(t, "Original", gotComment.Body)
	gotSprint, err := f.Store.GetSprint(ctx, ws, sprint.ID)
	require.NoError(t, err)
	require.Equal(t, "upcoming", gotSprint.State)
	var snapshots, links, assignments int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM sprint_snapshot WHERE sprint_id=$1`, sprint.ID).Scan(&snapshots))
	require.Zero(t, snapshots)
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM pr_link WHERE issue_id=$1`, issue.ID).Scan(&links))
	require.Equal(t, 1, links)
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM issue_label WHERE issue_id=$1`, issue.ID).Scan(&assignments))
	var commitIssue *uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT issue_id FROM commit_ref WHERE sha='synthetic'`).Scan(&commitIssue))
	require.Nil(t, commitIssue)
	require.Zero(t, assignments)
}

func TestDeleteCommentRechecksAdminDemotedToMember(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Issue")
	comment, err := f.Store.CreateComment(t.Context(), store.CreateCommentInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Body: "Keep"})
	require.NoError(t, err)
	actor, err := f.Store.UpsertUserByEmail(t.Context(), "former-admin@example.com")
	require.NoError(t, err)
	var membershipID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin') RETURNING id`, f.WorkspaceID, actor.ID).Scan(&membershipID))
	_, err = f.Store.UpdateWorkspaceMembershipRole(t.Context(), f.WorkspaceID, membershipID, f.User.ID, "member")
	require.NoError(t, err)
	require.ErrorIs(t, f.Store.DeleteComment(t.Context(), f.WorkspaceID, comment.ID, actor.ID), store.ErrForbidden)
	_, err = f.Store.GetComment(t.Context(), f.WorkspaceID, comment.ID)
	require.NoError(t, err)
}

func TestWriterRechecksAfterWorkspaceLock(t *testing.T) {
	for _, revoke := range []string{"demotion", "removal"} {
		t.Run(revoke, func(t *testing.T) {
			f := testutil.NewFixture(t)
			issue := testutil.CreateIssue(t, f, "Original")
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, err := f.Pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			require.NoError(t, store.LockWorkspaceAdminTx(ctx, tx, f.WorkspaceID, f.User.ID))
			done := make(chan error, 1)
			title := "Forbidden"
			go func() {
				_, err := f.Store.UpdateIssue(ctx, f.WorkspaceID, issue.ID, f.User.ID, store.IssuePatch{Title: &title})
				done <- err
			}()
			require.Eventually(t, func() bool {
				var waiting bool
				err := f.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
				return err == nil && waiting
			}, 3*time.Second, 10*time.Millisecond)
			if revoke == "demotion" {
				_, err = tx.Exec(ctx, `UPDATE membership SET role='viewer' WHERE user_id=$1`, f.User.ID)
			} else {
				_, err = tx.Exec(ctx, `DELETE FROM membership WHERE user_id=$1`, f.User.ID)
			}
			require.NoError(t, err)
			require.NoError(t, tx.Commit(ctx))
			require.ErrorIs(t, <-done, store.ErrForbidden)
			got, err := f.Store.GetIssueByKey(ctx, f.WorkspaceID, issue.Key)
			require.NoError(t, err)
			require.Equal(t, "Original", got.Title)
		})
	}
}

func TestWriterLockSerializesAdminRevocation(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	actor, err := f.Store.UpsertUserByEmail(ctx, "writer@example.com")
	require.NoError(t, err)
	var membershipID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member') RETURNING id`, f.WorkspaceID, actor.ID).Scan(&membershipID))
	tx, err := f.Pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	require.NoError(t, store.LockWorkspaceWriterTx(ctx, tx, f.WorkspaceID, actor.ID))
	done := make(chan error, 1)
	go func() {
		_, err := f.Store.UpdateWorkspaceMembershipRole(ctx, f.WorkspaceID, membershipID, f.User.ID, "viewer")
		done <- err
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := f.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
		return err == nil && waiting
	}, 3*time.Second, 10*time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("revocation passed writer lock: %v", err)
	default:
	}
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, <-done)
}

func TestImageConsumeRejectsRevokedWriter(t *testing.T) {
	for _, revoke := range []string{"demotion", "removal"} {
		t.Run(revoke, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			issue := testutil.CreateIssue(t, f, "Image")
			actor, err := f.Store.UpsertUserByEmail(ctx, "image-writer@example.com")
			require.NoError(t, err)
			var membershipID uuid.UUID
			require.NoError(t, f.Pool.QueryRow(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member') RETURNING id`, f.WorkspaceID, actor.ID).Scan(&membershipID))
			_, err = f.Store.CreateAPIToken(ctx, actor.ID, "upload")
			require.NoError(t, err)
			var tokenID uuid.UUID
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT id FROM api_token WHERE user_id=$1`, actor.ID).Scan(&tokenID))
			grant, err := f.Store.PrepareImageUpload(ctx, store.ImageInput{WorkspaceID: f.WorkspaceID, ActorID: actor.ID, APITokenID: &tokenID, TargetType: "issue", TargetID: issue.ID, Filename: "image.png", Caption: "Proof"})
			require.NoError(t, err)
			if revoke == "demotion" {
				_, err = f.Store.UpdateWorkspaceMembershipRole(ctx, f.WorkspaceID, membershipID, f.User.ID, "viewer")
			} else {
				err = f.Store.RemoveWorkspaceMembership(ctx, f.WorkspaceID, membershipID, f.User.ID)
			}
			require.NoError(t, err)
			_, err = f.Store.ConsumeImageUpload(ctx, "lab", grant.ID, grant.UploadToken, imageupload.Image{})
			require.ErrorIs(t, err, store.ErrUploadCredential)
			var count int
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM image_attachment WHERE workspace_id=$1`, f.WorkspaceID).Scan(&count))
			require.Zero(t, count)
		})
	}
}
