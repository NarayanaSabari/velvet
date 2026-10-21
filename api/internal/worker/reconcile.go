package worker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/jackc/pgx/v5"
)

// backfillWindow is how far back a never-synced repository is read. It doubles
// as the onboarding backfill, so the views are not empty on day one.
const backfillWindow = 90 * 24 * time.Hour

// Reconcile re-fetches every repository due for a sync and replays each pull
// request through the same path a webhook takes. Webhooks are missed in
// practice, so this is what keeps the record honest rather than
// approximately right.
func (w *Worker) Reconcile(ctx context.Context) error {
	// With no GitHub App configured there is nothing to reconcile against, and
	// no repository can have been linked. Idling is correct: the worker still
	// drains local jobs, and starts syncing once the App is configured.
	if w.gh == nil {
		return nil
	}
	var failures []error
	if err := w.store.ScheduleInstallationSyncs(ctx); err != nil {
		failures = append(failures, err)
	}

	repos, err := w.store.ReposDueForSync(ctx, reconcileInterval)
	if err != nil {
		return err
	}

	failedInstallations := map[int64]bool{}
	for _, repo := range repos {
		if failedInstallations[repo.InstallationID] {
			continue
		}
		if err := w.reconcileRepo(ctx, repo); err != nil {
			failedInstallations[repo.InstallationID] = true
			failures = append(failures, fmt.Errorf("reconcile %s/%s: %w", repo.Owner, repo.Name, err))
		}
	}
	return errors.Join(failures...)
}

func (w *Worker) reconcileRepo(ctx context.Context, repo store.Repo) error {
	current, err := w.store.ActiveRepo(ctx, repo.GitHubID, repo.InstallationID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	repo = current
	started := time.Now().UTC()
	since := started.Add(-backfillWindow)
	if repo.SyncedAt != nil {
		// GitHub rounds timestamps to seconds, so overlap the boundary.
		since = repo.SyncedAt.Add(-time.Second)
	}

	prs, err := w.gh.ListPullRequests(ctx, repo.InstallationID, repo.Owner, repo.Name, since)
	if err != nil {
		// Provider bodies never enter queue errors or logs.
		return errors.New("pull request sync failed")
	}
	for _, pr := range prs {
		if err := w.syncPullRequest(ctx, repo, pr); err != nil {
			return err
		}
		active, err := w.store.ActiveRepo(ctx, repo.GitHubID, repo.InstallationID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && active.SyncGeneration != repo.SyncGeneration) {
			return nil
		}
		if err != nil {
			return err
		}
		reviews, err := w.gh.ListReviews(ctx, repo.InstallationID, repo.Owner, repo.Name, pr.Number)
		if err != nil {
			return errors.New("pull request review sync failed")
		}
		for _, review := range reviews {
			if err := w.syncReview(ctx, repo, pr.Number, review); err != nil {
				return err
			}
		}
	}

	// Commit the start time only on success, keeping updates during the fetch eligible.
	return w.store.WithActiveRepo(ctx, repo, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE repo SET synced_at=$2 WHERE id=$1`, repo.ID, started)
		return err
	})
}
