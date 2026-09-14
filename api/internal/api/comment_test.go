package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCommentOnIssueRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Started on this today."})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var c store.Comment
	f.DecodeInto(rec, &c)
	require.Equal(t, "Started on this today.", c.Body)
	require.Equal(t, f.User.ID, c.Author.ID)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbCommented, c.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestRepliesNestOneLevelOnly(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Top level"})
	var top store.Comment
	f.DecodeInto(rec, &top)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Reply", "parent_id": top.ID.String()})
	require.Equal(t, http.StatusCreated, rec.Code)
	var reply store.Comment
	f.DecodeInto(rec, &reply)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Nested too deep", "parent_id": reply.ID.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	var list struct {
		Comments []store.Comment `json:"comments"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Comments, 1)
	require.Len(t, list.Comments[0].Replies, 1)
}

func TestMentionCreatesAnUnreadMention(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "@sabari can you review?"})
	require.Equal(t, http.StatusCreated, rec.Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/mentions?unread=true", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "can you review")
}

func TestMentionOfANonMemberIsIgnored(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "@stranger please look"})
	require.Equal(t, http.StatusCreated, rec.Code,
		"an unknown handle must not fail the comment")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM comment_mention`).Scan(&count))
	require.Equal(t, 0, count)
}

func TestOnlyTheAuthorCanEditAComment(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Mine"})
	var c store.Comment
	f.DecodeInto(rec, &c)

	// A second member of the same workspace must not be able to edit it.
	other, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 2002, Login: "other"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`INSERT INTO membership (workspace_id, user_id, role)
		 VALUES ($1, $2, 'member')`, f.WorkspaceID, other.ID)
	require.NoError(t, err)

	original := f.Token
	token, err := f.Store.CreateSession(t.Context(), other.ID, time.Hour)
	require.NoError(t, err)
	f.Token = token
	defer func() { f.Token = original }()

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/comments/"+c.ID.String(),
		map[string]any{"body": "Hijacked"})
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestDeletedCommentIsHiddenButPreserved(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Delete me"})
	var c store.Comment
	f.DecodeInto(rec, &c)

	require.Equal(t, http.StatusNoContent,
		f.Do(http.MethodDelete, "/api/v1/w/lab/comments/"+c.ID.String(), nil).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	require.NotContains(t, rec.Body.String(), "Delete me")

	var stillThere int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM comment WHERE id = $1 AND deleted_at IS NOT NULL`,
		c.ID).Scan(&stillThere))
	require.Equal(t, 1, stillThere, "the row is retained for the audit trail")
}

// The feed names what was commented on. Without these the row rendered
// "commented on" followed by nothing, which only showed up in a browser.
func TestCommentActivityNamesItsTarget(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
			map[string]any{"body": "Progress"}).Code)

	var key string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT metadata->>'key' FROM activity
		WHERE verb = $1 ORDER BY id DESC LIMIT 1`, store.VerbCommented).Scan(&key))
	require.Equal(t, issue.Key, key)
}

func TestMilestoneCommentActivityNamesTheMilestone(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/milestones/"+m.ID.String()+"/comments",
			map[string]any{"body": "On track."}).Code)

	var name string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT metadata->>'name' FROM activity
		WHERE verb = $1 ORDER BY id DESC LIMIT 1`, store.VerbCommented).Scan(&name))
	require.Equal(t, "Ship auth", name,
		"a milestone comment carries no issue key, so the name is what the feed can show")
}
