package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// databaseBefore migrates a fresh database up to, but not including, the
// named migration, so an upgrade can be tested against data written by the
// schema that came before it.
func databaseBefore(t *testing.T, stop string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, "postgres:18-alpine", tcpostgres.WithDatabase("upgrade"),
		tcpostgres.WithUsername("ticket"), tcpostgres.WithPassword("ticket"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(180*time.Second)))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, c.Terminate(context.Background())) })
	url, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	pool, err := Connect(ctx, url)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
	require.NoError(t, err)
	entries, err := migrationFS.ReadDir("migrations")
	require.NoError(t, err)
	for _, entry := range entries {
		if entry.Name() >= stop {
			break
		}
		body, err := migrationFS.ReadFile("migrations/" + entry.Name())
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(body))
		require.NoError(t, err, entry.Name())
		_, err = pool.Exec(ctx, `INSERT INTO schema_migration (name) VALUES ($1)`, entry.Name())
		require.NoError(t, err)
	}
	return pool
}

// Sprints written before a sprint belonged to a project must survive the
// upgrade with a sensible project, and nothing already filed may be lost.
func TestSprintProjectUpgradeGivesEverySprintAProject(t *testing.T) {
	pool := databaseBefore(t, "0011_sprint_project.sql")
	ctx := t.Context()
	_, err := pool.Exec(ctx, `
		INSERT INTO workspace (id, name, slug, issue_prefix) VALUES
		  ('00000000-0000-0000-0000-00000000000a', 'One project', 'one', 'ONE'),
		  ('00000000-0000-0000-0000-00000000000b', 'Two projects', 'two', 'TWO'),
		  ('00000000-0000-0000-0000-00000000000c', 'No projects', 'none', 'NON'),
		  ('00000000-0000-0000-0000-00000000000d', 'Owns general', 'gen', 'GEN'),
		  ('00000000-0000-0000-0000-00000000000e', 'No sprints', 'quiet', 'QUI');
		INSERT INTO project (id, workspace_id, key, name) VALUES
		  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'app', 'App'),
		  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'web', 'Web'),
		  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'api', 'API'),
		  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000d', 'general', 'Already general'),
		  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000d', 'other', 'Other');
		INSERT INTO sprint (id, workspace_id, name, starts_on, ends_on, state) VALUES
		  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-00000000000a', 'Sep', '2026-09-01', '2026-09-30', 'active'),
		  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-00000000000b', 'Sep', '2026-09-01', '2026-09-30', 'active'),
		  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-00000000000c', 'Sep', '2026-09-01', '2026-09-30', 'upcoming'),
		  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-00000000000d', 'Sep', '2026-09-01', '2026-09-30', 'upcoming');
		INSERT INTO milestone (id, workspace_id, sprint_id, name, position) VALUES
		  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a5', 'Ship', 'a');
		INSERT INTO issue (workspace_id, key, number, title, status, position, milestone_id, project_id) VALUES
		  ('00000000-0000-0000-0000-00000000000a', 'ONE-1', 1, 'In the milestone, no project', 'todo', 'a', '00000000-0000-0000-0000-0000000000a6', NULL);`)
	require.NoError(t, err)

	require.NoError(t, Migrate(ctx, pool))

	projectOf := func(sprint string) (key, name string) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, `SELECT p.key, p.name FROM sprint s JOIN project p ON p.id = s.project_id WHERE s.id = $1`, sprint).Scan(&key, &name))
		return key, name
	}
	// The only project is the obvious home.
	key, _ := projectOf("00000000-0000-0000-0000-0000000000a5")
	require.Equal(t, "app", key)
	// Ambiguous or missing projects get one General project to hold the sprint.
	key, name := projectOf("00000000-0000-0000-0000-0000000000b5")
	require.Equal(t, "general", key)
	require.Equal(t, "General", name)
	key, _ = projectOf("00000000-0000-0000-0000-0000000000c5")
	require.Equal(t, "general", key)
	// An existing "general" key is not reused or clashed with.
	key, name = projectOf("00000000-0000-0000-0000-0000000000d5")
	require.Equal(t, "general-sprints", key)
	require.Equal(t, "General", name)

	// Organisations without sprints are left alone.
	var quiet int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM project WHERE workspace_id = '00000000-0000-0000-0000-00000000000e'`).Scan(&quiet))
	require.Zero(t, quiet)

	// A ticket in a milestone now belongs to that milestone's project.
	var issueProject string
	require.NoError(t, pool.QueryRow(ctx, `SELECT p.key FROM issue i JOIN project p ON p.id = i.project_id WHERE i.key = 'ONE-1'`).Scan(&issueProject))
	require.Equal(t, "app", issueProject)

	// Every sprint must name a project from now on.
	_, err = pool.Exec(ctx, `INSERT INTO sprint (workspace_id, name, starts_on, ends_on) VALUES ('00000000-0000-0000-0000-00000000000a', 'No project', '2026-10-01', '2026-10-31')`)
	require.Error(t, err)

	// One active sprint per project, so two projects can be mid-sprint at once.
	_, err = pool.Exec(ctx, `INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on, state) VALUES
		('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'Web Sep', '2026-09-01', '2026-09-30', 'active')`)
	require.NoError(t, err, "a second project in the same organisation can have its own active sprint")
	_, err = pool.Exec(ctx, `INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on, state) VALUES
		('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'Web Oct', '2026-10-01', '2026-10-31', 'active')`)
	require.Error(t, err, "one project cannot have two active sprints")
}
