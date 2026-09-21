package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCreateAndListSprints(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September 2026", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var created store.Sprint
	f.DecodeInto(rec, &created)
	require.Equal(t, "upcoming", created.State)
	require.Equal(t, "2026-09-01", created.StartsOn)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Sprints []store.Sprint `json:"sprints"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Sprints, 1)
}

func TestSprintRejectsReversedDates(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Bad", "starts_on": "2026-09-30", "ends_on": "2026-09-01"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid_request")
}

func TestOnlyOneSprintCanBeActive(t *testing.T) {
	f := testutil.NewFixture(t)

	mk := func(name, from, to string) store.Sprint {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
			"name": name, "starts_on": from, "ends_on": to})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var s store.Sprint
		f.DecodeInto(rec, &s)
		return s
	}
	sept := mk("September", "2026-09-01", "2026-09-30")
	oct := mk("October", "2026-10-01", "2026-10-31")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/activate", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Activating October must close September rather than fail, because a team
	// rolling into a new month should not have to remember a manual step.
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+oct.ID.String()+"/activate", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	var list struct {
		Sprints []store.Sprint `json:"sprints"`
	}
	f.DecodeInto(rec, &list)

	active := 0
	for _, s := range list.Sprints {
		if s.State == "active" {
			active++
		}
	}
	require.Equal(t, 1, active)
}

func TestClosingASprintRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	var s store.Sprint
	f.DecodeInto(rec, &s)

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/activate", nil).Code)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/close", nil).Code)

	// Creation, activation, and closing are each recorded, so the query names
	// the verb it is checking rather than assuming a sprint has only one.
	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 AND verb = $2`,
		s.ID, store.VerbClosedSprint).Scan(&verb))
	require.Equal(t, store.VerbClosedSprint, verb)
}

func TestSprintsOfAnotherWorkspaceAreInvisible(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(),
		`INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
		 VALUES ($1, 'Secret', '2026-09-01', '2026-09-30')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), "Secret")

	rec = f.Do(http.MethodGet, "/api/v1/w/other/sprints", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
