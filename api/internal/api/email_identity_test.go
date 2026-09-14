package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// TestEmailOnlyIdentitySurvivesEveryUserProjection catches scalar scans of a
// nullable GitHub identity. Replacing any one of the nullable scans with a
// scalar makes its corresponding real HTTP response fail.
func TestEmailOnlyIdentitySurvivesEveryUserProjection(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	var emailUserID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx,
		`INSERT INTO app_user (email) VALUES ('member@example.com') RETURNING id`).Scan(&emailUserID))
	_, err := f.Pool.Exec(ctx, `
		INSERT INTO membership (workspace_id, user_id, role)
		VALUES ($1, $2, 'member')`, f.WorkspaceID, emailUserID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `UPDATE app_user SET name = 'Member' WHERE id = $1`, emailUserID)
	require.NoError(t, err)

	sprint := newSprint(t, f)
	var milestone store.Milestone
	require.NoError(t, f.Pool.QueryRow(ctx, `
		INSERT INTO milestone (workspace_id, sprint_id, name, description, position)
		VALUES ($1, $2, 'Email identity', '', 'V')
		RETURNING id, workspace_id, sprint_id, name, description, owner_id,
		          to_char(target_date, 'YYYY-MM-DD'), status::text, position,
		          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		          to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM')`,
		f.WorkspaceID, sprint.ID).Scan(
		&milestone.ID, &milestone.WorkspaceID, &milestone.SprintID, &milestone.Name,
		&milestone.Description, &milestone.OwnerID, &milestone.TargetDate, &milestone.Status,
		&milestone.Position, &milestone.CreatedAt, &milestone.UpdatedAt))
	issue := createIssue(t, f, map[string]any{
		"title": "Email-only work", "assignee_id": emailUserID.String(), "status": "in_progress",
	})

	token, err := f.Store.CreateSession(ctx, emailUserID, time.Hour)
	require.NoError(t, err)
	originalToken := f.Token
	f.Token = token
	defer func() { f.Token = originalToken }()

	require.Equal(t, http.StatusOK, f.Do(http.MethodGet, "/api/v1/me", nil).Code)

	members := f.Do(http.MethodGet, "/api/v1/w/lab/members", nil)
	require.Equal(t, http.StatusOK, members.Code, members.Body.String())
	var memberList struct {
		Members []store.User `json:"members"`
	}
	f.DecodeInto(members, &memberList)
	var member *store.User
	for i := range memberList.Members {
		if memberList.Members[i].ID == emailUserID {
			member = &memberList.Members[i]
			break
		}
	}
	require.NotNil(t, member)
	require.Equal(t, "member@example.com", member.Email)
	require.Nil(t, member.GitHubLogin)

	issueComment := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Email-only comment"})
	require.Equal(t, http.StatusCreated, issueComment.Code, issueComment.Body.String())
	milestoneComment := f.Do(http.MethodPost, "/api/v1/w/lab/milestones/"+milestone.ID.String()+"/comments",
		map[string]any{"body": "Email-only milestone comment"})
	require.Equal(t, http.StatusCreated, milestoneComment.Code, milestoneComment.Body.String())

	comments := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	require.Equal(t, http.StatusOK, comments.Code, comments.Body.String())
	var commentList struct {
		Comments []store.Comment `json:"comments"`
	}
	f.DecodeInto(comments, &commentList)
	require.Equal(t, emailUserID, commentList.Comments[0].Author.ID)
	require.Equal(t, "member@example.com", commentList.Comments[0].Author.Email)
	require.Nil(t, commentList.Comments[0].Author.GitHubLogin)

	milestones := f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", nil)
	require.Equal(t, http.StatusOK, milestones.Code, milestones.Body.String())
	var milestoneList struct {
		Milestones []store.Milestone `json:"milestones"`
	}
	f.DecodeInto(milestones, &milestoneList)
	require.Equal(t, emailUserID, milestoneList.Milestones[0].LastComment.Author.ID)
	require.Equal(t, "member@example.com", milestoneList.Milestones[0].LastComment.Author.Email)

	feed := f.Do(http.MethodGet, "/api/v1/w/lab/activity", nil)
	require.Equal(t, http.StatusOK, feed.Code, feed.Body.String())
	var activity struct {
		Activity []store.Activity `json:"activity"`
	}
	f.DecodeInto(feed, &activity)
	var emailActivity *store.Activity
	for i := range activity.Activity {
		if activity.Activity[i].Actor != nil && activity.Activity[i].Actor.ID == emailUserID {
			emailActivity = &activity.Activity[i]
			break
		}
	}
	require.NotNil(t, emailActivity)
	require.Equal(t, "member@example.com", emailActivity.Actor.Email)
	require.Nil(t, emailActivity.Actor.GitHubLogin)

	report := f.Do(http.MethodGet, "/api/v1/w/lab/reports/activity", nil)
	require.Equal(t, http.StatusOK, report.Code, report.Body.String())
	var reportBody struct {
		People []store.PersonActivityRow `json:"people"`
	}
	f.DecodeInto(report, &reportBody)
	var emailPerson *store.PersonActivityRow
	for i := range reportBody.People {
		if reportBody.People[i].UserID != nil && *reportBody.People[i].UserID == emailUserID {
			emailPerson = &reportBody.People[i]
			break
		}
	}
	require.NotNil(t, emailPerson)
	require.Equal(t, "member@example.com", emailPerson.Email)
	require.Nil(t, emailPerson.GitHubLogin)

	var sameNameUserID uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx, `
		INSERT INTO app_user (email, name) VALUES ('colleague@example.com', 'Member') RETURNING id`).
		Scan(&sameNameUserID))
	f.Token = originalToken
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)
	require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error {
		return store.RecordActivity(ctx, tx, store.ActivityInput{
			WorkspaceID: f.WorkspaceID, ActorID: sameNameUserID, Verb: store.VerbCommented,
			TargetType: "issue", TargetID: issue.ID,
		})
	}))
	require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error {
		return store.RecordActivity(ctx, tx, store.ActivityInput{
			WorkspaceID: f.WorkspaceID, Verb: store.VerbAttachedPR,
			TargetType: "issue", TargetID: issue.ID,
		})
	}))
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil).Code)

	f.Token = token
	snapshot := f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/snapshot", nil)
	require.Equal(t, http.StatusOK, snapshot.Code, snapshot.Body.String())
	var frozen store.SprintSnapshot
	f.DecodeInto(snapshot, &frozen)
	require.NotZero(t, frozen.PersonTotals["member@example.com"])
	require.NotZero(t, frozen.PersonTotals["colleague@example.com"])
	require.NotZero(t, frozen.PersonTotals["system"])
}
