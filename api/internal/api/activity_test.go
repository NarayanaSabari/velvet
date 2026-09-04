package api_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestTeamFeedReturnsNewestFirst(t *testing.T) {
	f := testutil.NewFixture(t)
	first := createIssue(t, f, map[string]any{"title": "First"})
	second := createIssue(t, f, map[string]any{"title": "Second"})

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var page struct {
		Activity   []store.Activity `json:"activity"`
		NextCursor string           `json:"next_cursor"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 2)
	require.Equal(t, second.ID, page.Activity[0].TargetID)
	require.Equal(t, first.ID, page.Activity[1].TargetID)
	require.Equal(t, f.User.ID, page.Activity[0].Actor.ID)
}

func TestFeedPaginatesWithACursor(t *testing.T) {
	f := testutil.NewFixture(t)
	for i := 0; i < 5; i++ {
		createIssue(t, f, map[string]any{"title": fmt.Sprintf("Issue %d", i)})
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity?limit=2", nil)
	var page struct {
		Activity   []store.Activity `json:"activity"`
		NextCursor string           `json:"next_cursor"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 2)
	require.NotEmpty(t, page.NextCursor)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/activity?limit=2&cursor="+page.NextCursor, nil)
	var next struct {
		Activity []store.Activity `json:"activity"`
	}
	f.DecodeInto(rec, &next)
	require.Len(t, next.Activity, 2)
	require.Less(t, next.Activity[0].ID, page.Activity[1].ID,
		"the second page must continue below the first")
}

func TestFeedFiltersByActor(t *testing.T) {
	f := testutil.NewFixture(t)
	createIssue(t, f, map[string]any{"title": "Mine"})

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity?actor_id="+f.User.ID.String(), nil)
	var page struct {
		Activity []store.Activity `json:"activity"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 1)

	other := "00000000-0000-0000-0000-000000000009"
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/activity?actor_id="+other, nil)
	f.DecodeInto(rec, &page)
	require.Empty(t, page.Activity)
}

func TestDashboardReturnsMyWorkAndMentions(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)

	issue := createIssue(t, f, map[string]any{
		"title": "Mine", "assignee_id": f.User.ID.String(), "status": "in_progress"})
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
			map[string]any{"body": "@sabari look at this"}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/dashboard", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var dash store.DashboardPayload
	f.DecodeInto(rec, &dash)
	require.Len(t, dash.MyIssues, 1)
	require.Equal(t, issue.Key, dash.MyIssues[0].Key)
	require.Equal(t, 1, dash.UnreadMentions)
	require.NotNil(t, dash.ActiveSprint)
	require.NotEmpty(t, dash.Activity)
}

func TestActivityOfAnotherWorkspaceIsInvisible(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO activity (workspace_id, verb, target_type, target_id, metadata)
		VALUES ($1, 'created_issue', 'issue', gen_random_uuid(), '{"title":"Secret"}')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity", nil)
	require.NotContains(t, rec.Body.String(), "Secret")
}
