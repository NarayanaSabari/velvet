package store_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestProjectScopedReportsAndMentions(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()
	var ws uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES('Lab','scope') RETURNING id`).Scan(&ws))
	user, err := testutil.CreateLinkedUser(t, st, store.GitHubIdentity{ID: 991, Login: "scope"})
	require.NoError(t, err)
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	projects := []uuid.UUID{uuid.New(), uuid.New()}
	sprints := []uuid.UUID{uuid.New(), uuid.New()}
	milestones := []uuid.UUID{uuid.New(), uuid.New()}
	issues := []uuid.UUID{uuid.New(), uuid.New()}
	comments := make([][]uuid.UUID, 2)
	for n := range projects {
		exec(`INSERT INTO project(id,workspace_id,key,name) VALUES($1,$2,$3,$3)`, projects[n], ws, fmt.Sprintf("p%d", n))
		exec(`INSERT INTO sprint(id,workspace_id,project_id,name,starts_on,ends_on) VALUES($1,$2,$3,'Sprint','2026-01-01','2026-01-14')`, sprints[n], ws, projects[n])
		exec(`INSERT INTO milestone(id,workspace_id,sprint_id,name,position,status) VALUES($1,$2,$3,'Milestone','a','completed')`, milestones[n], ws, sprints[n])
		exec(`INSERT INTO issue(id,workspace_id,project_id,milestone_id,key,number,title,position,updated_at) VALUES($1,$2,$3,$4,$5,$6,'Issue','a',now()-interval '30 days')`, issues[n], ws, projects[n], milestones[n], fmt.Sprintf("ENG-%d", n+1), n+1)
		for j, target := range []uuid.UUID{issues[n], milestones[n], projects[n]} {
			typ := []string{"issue", "milestone", "project"}[j]
			id := uuid.New()
			comments[n] = append(comments[n], id)
			exec(`INSERT INTO comment(id,workspace_id,target_type,target_id,author_id,body,created_at) VALUES($1,$2,$3,$4,$5,'@scope',now()-interval '30 days')`, id, ws, typ, target, user.ID)
			exec(`INSERT INTO comment_mention(comment_id,user_id) VALUES($1,$2)`, id, user.ID)
			exec(`INSERT INTO activity(workspace_id,actor_id,verb,target_type,target_id,created_at) VALUES($1,$2,'commented','comment',$3,now()-interval '30 days')`, ws, user.ID, id)
			got, err := st.CommentProjectID(ctx, ws, id)
			require.NoError(t, err)
			require.Equal(t, projects[n], *got)
		}
		for j, target := range []uuid.UUID{issues[n], milestones[n], projects[n], sprints[n]} {
			exec(`INSERT INTO activity(workspace_id,actor_id,verb,target_type,target_id,created_at) VALUES($1,$2,'changed',$3,$4,now()-interval '30 days')`, ws, user.ID, []string{"issue", "milestone", "project", "sprint"}[j], target)
		}
	}
	// Unfiled work and workspace-only activity must not enter project reports.
	unfiled := uuid.New()
	exec(`INSERT INTO issue(id,workspace_id,key,number,title,position,updated_at) VALUES($1,$2,'ENG-3',3,'Unfiled','a',now()-interval '30 days')`, unfiled, ws)
	exec(`INSERT INTO activity(workspace_id,actor_id,verb,target_type,target_id) VALUES($1,$2,'changed','issue',$3),($1,$2,'invited','membership',$4)`, ws, user.ID, unfiled, uuid.New())
	// Legacy inconsistent links must not count another project's issue in this sprint.
	exec(`UPDATE issue SET milestone_id=$1 WHERE id=$2`, milestones[0], issues[1])
	activity, err := st.PersonActivity(ctx, ws, "", "", &projects[0])
	require.NoError(t, err)
	require.Len(t, activity, 1)
	require.Equal(t, 7, activity[0].Total)
	require.Equal(t, 3, activity[0].Verbs["commented"])
	allActivity, err := st.PersonActivity(ctx, ws, "", "")
	require.NoError(t, err)
	require.Equal(t, 16, allActivity[0].Total)
	bounded, err := st.PersonActivity(ctx, ws, "2099-01-01", "", &projects[0])
	require.NoError(t, err)
	require.Empty(t, bounded)
	completion, err := st.MilestoneCompletion(ctx, ws, &projects[0])
	require.NoError(t, err)
	require.Len(t, completion, 1)
	require.Equal(t, sprints[0], completion[0].SprintID)
	require.Equal(t, 1, completion[0].Planned)
	require.Equal(t, 1, completion[0].Completed)
	closed, err := st.IssuesClosedPerSprint(ctx, ws, &projects[0])
	require.NoError(t, err)
	require.Len(t, closed, 1)
	require.Equal(t, 1, closed[0].Total)
	require.Equal(t, 0, closed[0].Closed)
	stale, err := st.StaleIssues(ctx, ws, 14, &projects[0])
	require.NoError(t, err)
	require.Len(t, stale, 1)
	require.Equal(t, issues[0], stale[0].ID)
	mentions, err := st.ListMentions(ctx, ws, user.ID, true, &projects[0])
	require.NoError(t, err)
	require.Len(t, mentions, 3)
	require.NoError(t, st.MarkMentionsRead(ctx, ws, user.ID, []uuid.UUID{comments[1][0]}, &projects[0]))
	mentions, err = st.ListMentions(ctx, ws, user.ID, true, &projects[1])
	require.NoError(t, err)
	require.Len(t, mentions, 3)
	require.NoError(t, st.MarkMentionsRead(ctx, ws, user.ID, nil, &projects[0]))
	mentions, err = st.ListMentions(ctx, ws, user.ID, true, &projects[0])
	require.NoError(t, err)
	require.Empty(t, mentions)
	mentions, err = st.ListMentions(ctx, ws, user.ID, true, &projects[1])
	require.NoError(t, err)
	require.Len(t, mentions, 3)
	all, err := st.ListMentions(ctx, ws, user.ID, false)
	require.NoError(t, err)
	require.Len(t, all, 6)
	_, err = st.CommentProjectID(ctx, uuid.New(), comments[0][0])
	require.ErrorIs(t, err, store.ErrNotFound)
	// A valid target UUID from a different workspace is not ownership proof.
	var otherWorkspace uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES('Other','other') RETURNING id`).Scan(&otherWorkspace))
	invalidComment := uuid.New()
	exec(`INSERT INTO comment(id,workspace_id,target_type,target_id,author_id,body) VALUES($1,$2,'project',$3,$4,'@scope')`, invalidComment, otherWorkspace, projects[0], user.ID)
	exec(`INSERT INTO comment_mention(comment_id,user_id) VALUES($1,$2)`, invalidComment, user.ID)
	_, err = st.CommentProjectID(ctx, otherWorkspace, invalidComment)
	require.ErrorIs(t, err, store.ErrNotFound)
	invalidMentions, err := st.ListMentions(ctx, otherWorkspace, user.ID, true, &projects[0])
	require.NoError(t, err)
	require.Empty(t, invalidMentions)
	require.NoError(t, st.MarkMentionsRead(ctx, otherWorkspace, user.ID, nil, &projects[0]))
	var stillUnread bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT read_at IS NULL FROM comment_mention WHERE comment_id=$1`, invalidComment).Scan(&stillUnread))
	require.True(t, stillUnread)
	exec(`UPDATE comment SET deleted_at=now() WHERE id=$1`, comments[0][0])
	_, err = st.CommentProjectID(ctx, ws, comments[0][0])
	require.ErrorIs(t, err, store.ErrNotFound)
}
