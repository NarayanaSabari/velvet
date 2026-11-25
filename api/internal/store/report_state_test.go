package store_test

import (
	"context"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// A reader needs the sprint's state to tell a sprint that closed at 0% from
// one that simply has not finished, so the completion report carries it.
func TestMilestoneCompletionReportsSprintState(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var ws, project uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace(name,slug) VALUES('Lab','state') RETURNING id`).Scan(&ws))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO project(workspace_id,key,name) VALUES($1,'p','P') RETURNING id`, ws).Scan(&project))
	for _, sprint := range []struct{ name, starts, state string }{
		{"Closed", "2026-01-01", "completed"},
		{"Running", "2026-02-01", "active"},
		{"Planned", "2026-03-01", "upcoming"},
	} {
		_, err := pool.Exec(ctx, `
			INSERT INTO sprint(workspace_id,project_id,name,starts_on,ends_on,state)
			VALUES($1,$2,$3,$4::date,$4::date + 13,$5::sprint_state)`,
			ws, project, sprint.name, sprint.starts, sprint.state)
		require.NoError(t, err)
	}

	rows, err := st.MilestoneCompletion(ctx, ws)
	require.NoError(t, err)
	states := map[string]string{}
	for _, row := range rows {
		states[row.SprintName] = row.State
	}
	require.Equal(t, map[string]string{
		"Closed": "completed", "Running": "active", "Planned": "upcoming",
	}, states)
}
