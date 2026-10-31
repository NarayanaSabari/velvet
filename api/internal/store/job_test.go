package store_test

import (
	"context"
	"testing"
	"time"

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

	require.NoError(t, st.CompleteJob(ctx, job))

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
	require.NoError(t, st.FailJob(ctx, job, "boom"))

	// Backoff means it is not immediately claimable again.
	_, err = st.ClaimJob(ctx)
	require.ErrorIs(t, err, store.ErrNotFound)

	// After five failures it is dead-lettered rather than retried forever.
	_, err = st.Pool().Exec(ctx,
		`UPDATE job SET attempts = 5, run_after = now() WHERE id = $1`, job.ID)
	require.NoError(t, err)

	job, err = st.ClaimJob(ctx)
	require.NoError(t, err)
	require.NoError(t, st.FailJob(ctx, job, "boom again"))

	var dead bool
	require.NoError(t, st.Pool().QueryRow(ctx,
		`SELECT dead FROM job WHERE id = $1`, job.ID).Scan(&dead))
	require.True(t, dead)
}

func TestExpiredJobClaimCannotAffectNewOwner(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := t.Context()
	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		return st.EnqueueJob(ctx, tx, "process_delivery", map[string]any{"delivery_id": "slow"})
	}))
	old, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	_, err = st.Pool().Exec(ctx, `UPDATE job SET run_after = now() - interval '1 second' WHERE id = $1`, old.ID)
	require.NoError(t, err)
	current, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	require.Equal(t, old.ID, current.ID)
	require.Equal(t, old.Attempts+1, current.Attempts)

	var lease time.Time
	require.NoError(t, st.Pool().QueryRow(ctx, `SELECT run_after FROM job WHERE id = $1`, current.ID).Scan(&lease))
	require.ErrorIs(t, st.CompleteJob(ctx, old), store.ErrStaleJob)
	require.ErrorIs(t, st.FailJob(ctx, old, "late failure"), store.ErrStaleJob)

	var attempts int
	var dead bool
	var lastError string
	var after time.Time
	require.NoError(t, st.Pool().QueryRow(ctx,
		`SELECT attempts, dead, coalesce(last_error, ''), run_after FROM job WHERE id = $1`, current.ID).
		Scan(&attempts, &dead, &lastError, &after))
	require.Equal(t, current.Attempts, attempts)
	require.False(t, dead)
	require.Empty(t, lastError)
	require.Equal(t, lease, after)
	require.NoError(t, st.CompleteJob(ctx, current))
	require.ErrorIs(t, st.FailJob(ctx, old, "late failure after completion"), store.ErrStaleJob)
}
