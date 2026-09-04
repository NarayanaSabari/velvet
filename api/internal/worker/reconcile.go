package worker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// backfillWindow is how far back a never-synced repository is read. It doubles
// as the onboarding backfill, so the views are not empty on day one.
const backfillWindow = 90 * 24 * time.Hour

// Reconcile re-fetches every repository due for a sync and replays each pull
// request through the same path a webhook takes. Webhooks are missed in
// practice, so this is what keeps the record honest rather than
// approximately right.
func (w *Worker) Reconcile(ctx context.Context) error {
	repos, err := w.store.ReposDueForSync(ctx, reconcileInterval)
	if err != nil {
		return err
	}

	for _, repo := range repos {
		if err := w.reconcileRepo(ctx, repo); err != nil {
			// A rate limit stops the whole pass: every later repo shares the
			// same installation budget, so continuing would only burn retries.
			if errors.Is(err, github.ErrRateLimited) {
				return err
			}
			return fmt.Errorf("reconcile %s/%s: %w", repo.Owner, repo.Name, err)
		}
	}
	return nil
}

func (w *Worker) reconcileRepo(ctx context.Context, repo store.Repo) error {
	since := time.Now().Add(-backfillWindow)
	if repo.SyncedAt != nil {
		since = *repo.SyncedAt
	}

	prs, err := w.gh.ListPullRequests(ctx, repo.InstallationID, repo.Owner, repo.Name, since)
	if err != nil {
		return err
	}
	for _, pr := range prs {
		if err := w.syncPullRequest(ctx, repo, pr); err != nil {
			return err
		}
	}

	// Stamped only after the repo finishes. Stamping after a failed fetch
	// would move the window past a gap that was never actually read.
	return w.store.MarkRepoSynced(ctx, repo.ID)
}
