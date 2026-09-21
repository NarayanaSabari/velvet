package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// A manager assigns work in a sprint that may not exist yet. Someone who is
// only a member of that organisation still has to be able to create it,
// otherwise they cannot record the work they were told to do.
func TestAMemberCanRunSprintsAndEveryChangeIsRecorded(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	_, err := f.Pool.Exec(ctx,
		`UPDATE membership SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`,
		f.WorkspaceID, f.User.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints",
		map[string]any{"name": "September 2026", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var sprint store.Sprint
	f.DecodeInto(rec, &sprint)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Every change is attributable, which is the condition for relaxing the
	// role gate in the first place.
	for _, verb := range []string{
		store.VerbCreatedSprint, store.VerbActivatedSprint, store.VerbClosedSprint,
	} {
		var actor string
		require.NoError(t, f.Pool.QueryRow(ctx,
			`SELECT actor_id::text FROM activity
			 WHERE verb = $1 AND target_type = 'sprint' AND target_id = $2`,
			verb, sprint.ID).Scan(&actor), "%s must be recorded", verb)
		require.Equal(t, f.User.ID.String(), actor, "%s must name who did it", verb)
	}
}

// A viewer reads the record but does not write it.
func TestAViewerStillCannotRunSprints(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(),
		`UPDATE membership SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2`,
		f.WorkspaceID, f.User.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints",
		map[string]any{"name": "September 2026", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// Activating a sprint completes the one that was active, and that change is
// recorded too rather than happening silently.
func TestActivatingASprintRecordsTheSwitch(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	create := func(name, from, to string) store.Sprint {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints",
			map[string]any{"name": name, "starts_on": from, "ends_on": to})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var s store.Sprint
		f.DecodeInto(rec, &s)
		return s
	}

	first := create("September 2026", "2026-09-01", "2026-09-30")
	second := create("October 2026", "2026-10-01", "2026-10-31")

	for _, s := range []store.Sprint{first, second} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/activate", nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}

	var activations int
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT count(*) FROM activity WHERE verb = $1`,
		store.VerbActivatedSprint).Scan(&activations))
	require.Equal(t, 2, activations)

	var state string
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT state::text FROM sprint WHERE id = $1`, first.ID).Scan(&state))
	require.Equal(t, "completed", state, "only one sprint may be active at a time")
}
