package db_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestMigrateIsIdempotent(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()

	// Running again must be a no-op rather than an error.
	require.NoError(t, db.Migrate(ctx, pool))

	var tables int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public'`).Scan(&tables)
	require.NoError(t, err)
	require.GreaterOrEqual(t, tables, 12)
}

func TestSubIssueNestingIsRejected(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Test', 'test') RETURNING id`).Scan(&wsID))

	newIssue := func(key string, parent *string) (string, error) {
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, key, number, title, position, parent_id)
			VALUES ($1, $2, $3, $4, 'V', $5) RETURNING id`,
			wsID, key, len(key), "t "+key, parent).Scan(&id)
		return id, err
	}

	root, err := newIssue("ENG-1", nil)
	require.NoError(t, err)
	child, err := newIssue("ENG-2", &root)
	require.NoError(t, err)

	_, err = newIssue("ENG-3", &child)
	require.Error(t, err, "a grandchild must be rejected by the depth guard")
}
