package api_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestIssueListBoundedFiltersAndCounts(t *testing.T) {
	f := testutil.NewFixture(t)
	first := createIssue(t, f, map[string]any{"title": "Literal 100%_target", "description": "Search this narrative", "priority": 0})
	second := createIssue(t, f, map[string]any{"title": "Second target", "priority": 0})
	createIssue(t, f, map[string]any{"title": "Assigned", "priority": 3, "status": "todo", "assignee_id": f.User.ID.String()})
	type page struct {
		Assignees []string      `json:"assignee_ids"`
		Issues    []store.Issue `json:"issues"`
		Next      string        `json:"next_cursor"`
		Matched   int           `json:"matched_count"`
		Total     int           `json:"total_count"`
	}
	get := func(query string) page {
		t.Helper()
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues?include_counts=true&"+query, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var p page
		f.DecodeInto(rec, &p)
		return p
	}
	p := get("limit=1&priority=0&unassigned=true&unfiled=true&q=TARGET")
	require.Len(t, p.Issues, 1)
	require.Equal(t, first.ID, p.Issues[0].ID)
	require.Equal(t, 2, p.Matched)
	require.Equal(t, 3, p.Total)
	require.Equal(t, []string{f.User.ID.String()}, p.Assignees, "off-page assignments must remain filterable")
	require.NotEmpty(t, p.Next)
	p = get("limit=1&priority=0&unassigned=true&unfiled=true&q=TARGET&cursor=" + url.QueryEscape(p.Next))
	require.Len(t, p.Issues, 1)
	require.Equal(t, second.ID, p.Issues[0].ID)
	require.Empty(t, p.Next, "an exact final page must not advertise an empty next page")
	require.Equal(t, 2, p.Matched, "counts must ignore the cursor")
	require.Equal(t, 3, p.Total)
	for _, q := range []string{"100%_", "NARRATIVE", first.Key} {
		p = get("q=" + url.QueryEscape(q))
		require.Len(t, p.Issues, 1)
		require.Equal(t, first.ID, p.Issues[0].ID)
	}
	p = get("q=missing")
	require.Empty(t, p.Issues)
	require.Zero(t, p.Matched)
	require.Equal(t, 3, p.Total)
	p = get("status=todo&assignee_id=" + f.User.ID.String() + "&priority=3")
	require.Len(t, p.Issues, 1)
	require.Equal(t, 1, p.Matched)
	for _, invalid := range []string{"priority=-1", "priority=5", "priority=no", "unassigned=no", "unfiled=no", "cursor=no"} {
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues?"+invalid, nil)
		require.Equal(t, http.StatusBadRequest, rec.Code, invalid+": "+rec.Body.String())
	}
}

func TestIssueListCountsRespectProjectAndWorkspaceScope(t *testing.T) {
	s := newScopedSetup(t)
	require.Equal(t, http.StatusOK, s.f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+s.otherIssue.Key, map[string]any{"assignee_id": s.f.User.ID.String()}).Code)
	for _, test := range []struct {
		query   string
		matched int
	}{
		{"", 1}, {"&unfiled=true", 0}, {"&q=Other", 0},
	} {
		rec := s.as(http.MethodGet, "/api/v1/w/lab/issues?include_counts=true"+test.query, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			Assignees []string `json:"assignee_ids"`
			Matched   int      `json:"matched_count"`
			Total     int      `json:"total_count"`
		}
		s.f.DecodeInto(rec, &body)
		require.Equal(t, test.matched, body.Matched)
		require.Equal(t, 1, body.Total, "metadata must never count tickets outside a scoped key")
		require.Empty(t, body.Assignees, "assignee metadata must not expose another project's assignments")
	}
	for _, query := range []string{"project=own", "project_id=" + s.ownProject.String(), "unfiled=true"} {
		rec := s.f.Do(http.MethodGet, "/api/v1/w/lab/issues?include_counts=true&"+query, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			Issues  []store.Issue `json:"issues"`
			Matched int           `json:"matched_count"`
			Total   int           `json:"total_count"`
		}
		s.f.DecodeInto(rec, &body)
		require.Len(t, body.Issues, 1)
		require.Equal(t, 1, body.Matched)
		require.Equal(t, 3, body.Total, "other workspaces must not affect the workspace count")
	}
}
