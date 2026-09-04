package store_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestClaimJobReturnsEachJobOnce(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		return st.EnqueueJob(ctx, tx, "process_delivery", map[string]any{"delivery_id": "d1"})
	}))

	job, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	require.Equal(t, "process_delivery", job.Kind)

	// A second claim before completion must find nothing: two workers must
	// never process the same delivery.
	_, err = st.ClaimJob(ctx)
	require.ErrorIs(t, err, store.ErrNotFound)

	require.NoError(t, st.CompleteJob(ctx, job.ID))

	var remaining int
	require.NoError(t, st.Pool().QueryRow(ctx, `SELECT count(*) FROM job`).Scan(&remaining))
	require.Equal(t, 0, remaining)
}

func TestFailedJobBacksOffThenDies(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		return st.EnqueueJob(ctx, tx, "process_delivery", map[string]any{"delivery_id": "d1"})
	}))

	job, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	require.NoError(t, st.FailJob(ctx, job.ID, "boom"))

	// Backoff means it is not immediately claimable again.
	_, err = st.ClaimJob(ctx)
	require.ErrorIs(t, err, store.ErrNotFound)

	// After five failures it is dead-lettered rather than retried forever.
	_, err = st.Pool().Exec(ctx,
		`UPDATE job SET attempts = 5, run_after = now() WHERE id = $1`, job.ID)
	require.NoError(t, err)

	job, err = st.ClaimJob(ctx)
	require.NoError(t, err)
	require.NoError(t, st.FailJob(ctx, job.ID, "boom again"))

	var dead bool
	require.NoError(t, st.Pool().QueryRow(ctx,
		`SELECT dead FROM job WHERE id = $1`, job.ID).Scan(&dead))
	require.True(t, dead)
}
