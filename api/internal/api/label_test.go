package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCreateAndListLabels(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels",
		map[string]any{"name": "bug", "color": "#b91c1c"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/labels", nil)
	var list struct {
		Labels []store.Label `json:"labels"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Labels, 1)
	require.Equal(t, "bug", list.Labels[0].Name)
}

func TestDuplicateLabelNameIsRejected(t *testing.T) {
	f := testutil.NewFixture(t)
	body := map[string]any{"name": "bug", "color": "#b91c1c"}
	require.Equal(t, http.StatusCreated, f.Do(http.MethodPost, "/api/v1/w/lab/labels", body).Code)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels", body)
	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestSetIssueLabelsReplacesTheSet(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	mk := func(name string) store.Label {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels",
			map[string]any{"name": name, "color": "#111111"})
		require.Equal(t, http.StatusCreated, rec.Code)
		var l store.Label
		f.DecodeInto(rec, &l)
		return l
	}
	bug, chore := mk("bug"), mk("chore")

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{bug.ID.String(), chore.ID.String()}})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{chore.ID.String()}})
	require.Equal(t, http.StatusOK, rec.Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Len(t, got.Labels, 1)
	require.Equal(t, "chore", got.Labels[0].Name)
}

func TestLabelFromAnotherWorkspaceCannotBeAttached(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	var otherWS, foreignLabel string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO label (workspace_id, name) VALUES ($1, 'foreign') RETURNING id`,
		otherWS).Scan(&foreignLabel))

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{foreignLabel}})
	require.Equal(t, http.StatusBadRequest, rec.Code,
		"a label from another workspace must be refused")
}
