package worker_test

import (
	"context"
	"testing"

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
