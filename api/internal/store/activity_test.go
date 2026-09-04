package store_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestRecordActivityRollsBackWithItsTransaction(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 3, Login: "dev"})
	require.NoError(t, err)

	// A failing transaction must leave no activity behind, which is the whole
	// reason activity is written in the same transaction as the change.
	err = st.InTx(ctx, func(tx pgx.Tx) error {
		if err := store.RecordActivity(ctx, tx, store.ActivityInput{
			WorkspaceID: wsID, ActorID: u.ID, Verb: store.VerbCreatedIssue,
			TargetType: "issue", TargetID: uuid.New(),
		}); err != nil {
			return err
		}
		return context.Canceled
	})
	require.Error(t, err)

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM activity`).Scan(&count))
	require.Equal(t, 0, count)
}

func TestNextIssueKeyIncrementsPerWorkspace(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Lab', 'lab', 'ENG')
		 RETURNING id`).Scan(&wsID))

	var keys []string
	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		for i := 0; i < 3; i++ {
			key, _, err := st.NextIssueKey(ctx, tx, wsID)
			if err != nil {
				return err
			}
			keys = append(keys, key)
		}
		return nil
	}))
	require.Equal(t, []string{"ENG-1", "ENG-2", "ENG-3"}, keys)
}
