package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestBootstrapReturnsProjectsMembersAndLabels(t *testing.T) {
	f := testutil.NewFixture(t)
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/labels", map[string]any{"name": "bug", "color": "#b91c1c"}).Code)
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/projects", map[string]any{"key": "web", "name": "Web"}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/bootstrap", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Projects []store.Project `json:"projects"`
		Members  []store.User    `json:"members"`
		Labels   []store.Label   `json:"labels"`
	}
	f.DecodeInto(rec, &out)
	require.Len(t, out.Projects, 1)
	require.NotEmpty(t, out.Members)
	require.Len(t, out.Labels, 1)
}

func TestIssueListSummaryOmitsDescription(t *testing.T) {
	f := testutil.NewFixture(t)
	createIssue(t, f, map[string]any{"title": "Ship it", "description": "Long narrative"})

	var list struct {
		Issues []store.Issue `json:"issues"`
	}
	f.DecodeInto(f.Do(http.MethodGet, "/api/v1/w/lab/issues", nil), &list)
	require.Equal(t, "Long narrative", list.Issues[0].Description)

	f.DecodeInto(f.Do(http.MethodGet, "/api/v1/w/lab/issues?fields=summary", nil), &list)
	require.Equal(t, "Ship it", list.Issues[0].Title)
	require.Empty(t, list.Issues[0].Description)
}
