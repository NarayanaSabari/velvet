package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

// A fresh install has no GitHub App configured. The worker must still start
// and idle rather than crash-looping, which is what a new deployment shows.
func TestReconcileWithoutGitHubAppIsANoOp(t *testing.T) {
	f := testutil.NewFixture(t)
	w := worker.New(f.Store, nil)
	require.NoError(t, w.Reconcile(t.Context()))
}

func TestRunStopsCleanlyWhenCancelled(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	require.NoError(t, worker.New(f.Store, nil).Run(ctx))
}

func TestRunCleansExpiredAuthenticationAtStartup(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO login_token(email,token_hash,request_ip,created_at,expires_at) VALUES ('old@example.com','old-token','127.0.0.1',now()-interval '1 hour',now()-interval '30 minutes')`)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- worker.New(f.Store, nil).Run(ctx) }()
	require.Eventually(t, func() bool {
		var n int
		err := f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&n)
		return err == nil && n == 0
	}, time.Second, 10*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
}
