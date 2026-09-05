// Package worker drains the Postgres job queue and does the real GitHub work:
// mirroring pull requests, commits, and reviews onto issue timelines.
//
// It records evidence and never controls workflow. Nothing in this package
// writes issue.status, because a merged branch is what happened in the code
// and only a person can say what it means for the issue.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// reconcileInterval is how often a repo is re-fetched. Webhooks are missed in
// practice, and a system that assumes otherwise is quietly wrong within a
// month.
const reconcileInterval = time.Hour

// idlePause is how long Run waits when the queue is empty, which keeps an idle
// worker from spinning on the database.
const idlePause = 2 * time.Second

// sessionCleanupInterval bounds how long expired authentication rows remain
// after they stop being usable.
const sessionCleanupInterval = 24 * time.Hour

type Worker struct {
	store *store.Store
	gh    *github.Client
}

func New(st *store.Store, gh *github.Client) *Worker {
	return &Worker{store: st, gh: gh}
}

// Run drains the queue until the context is cancelled, reconciling on a ticker
// alongside. It only loops over ProcessOnce, so no test has to depend on
// timing.
func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(reconcileInterval)
	defer ticker.Stop()
	sessionTicker := time.NewTicker(sessionCleanupInterval)
	defer sessionTicker.Stop()
	select {
	case <-ctx.Done():
		return nil
	default:
	}

	if _, err := w.store.DeleteExpiredSessions(ctx); err != nil {
		slog.Error("delete expired sessions", "err", err)
	}

	// Reconcile once at start, which is also what backfills a freshly
	// onboarded repository without waiting an hour for the first tick.
	if err := w.Reconcile(ctx); err != nil {
		slog.Error("reconcile", "err", err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := w.Reconcile(ctx); err != nil {
				slog.Error("reconcile", "err", err)
			}
		case <-sessionTicker.C:
			if _, err := w.store.DeleteExpiredSessions(ctx); err != nil {
				slog.Error("delete expired sessions", "err", err)
			}
		default:
		}

		did, err := w.ProcessOnce(ctx)
		if err != nil {
			slog.Error("process job", "err", err)
		}
		if !did {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(idlePause):
			}
		}
	}
}

// ProcessOnce claims and runs at most one job, reporting whether there was one
// to run. A handler error fails the job so it retries with backoff; a payload
// the worker cannot ever act on completes instead, because retrying an
// unattributable delivery forever only fills the dead-letter queue.
func (w *Worker) ProcessOnce(ctx context.Context) (bool, error) {
	job, err := w.store.ClaimJob(ctx)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	if err := w.runJob(ctx, job); err != nil {
		if failErr := w.store.FailJob(ctx, job.ID, err.Error()); failErr != nil {
			return true, fmt.Errorf("fail job %d: %w", job.ID, failErr)
		}
		return true, err
	}
	return true, w.store.CompleteJob(ctx, job.ID)
}

func (w *Worker) runJob(ctx context.Context, job store.Job) error {
	switch job.Kind {
	case "process_delivery":
		var payload struct {
			DeliveryID string `json:"delivery_id"`
		}
		if err := json.Unmarshal(job.Payload, &payload); err != nil {
			return fmt.Errorf("decode job payload: %w", err)
		}
		return w.processDelivery(ctx, payload.DeliveryID)
	default:
		// An unknown kind is not retryable, so it is completed rather than
		// failed: a stray enqueue must not accumulate in the dead letters.
		slog.Warn("unknown job kind", "kind", job.Kind, "id", job.ID)
		return nil
	}
}

func (w *Worker) processDelivery(ctx context.Context, deliveryID string) error {
	eventType, payload, err := w.store.DeliveryPayload(ctx, deliveryID)
	if errors.Is(err, store.ErrNotFound) {
		// The delivery row is gone; there is nothing to do and never will be.
		return nil
	}
	if err != nil {
		return err
	}

	switch eventType {
	case "pull_request":
		err = w.handlePullRequest(ctx, payload)
	case "pull_request_review":
		err = w.handleReview(ctx, payload)
	case "push":
		err = w.handlePush(ctx, payload)
	case "installation", "installation_repositories":
		err = w.handleInstallation(ctx, payload)
	default:
		// An unexpected subscription is ignored, not failed. GitHub can be
		// configured to send more than this worker knows about.
		slog.Debug("unhandled event type", "type", eventType)
	}
	if err != nil {
		return err
	}
	return w.store.MarkDeliveryProcessed(ctx, deliveryID)
}

// repoFromPayload resolves the repository a delivery belongs to. A repository
// nobody has linked cannot be attributed to a workspace, and no amount of
// retrying will change that, so the caller drops the delivery.
func (w *Worker) repoFromPayload(ctx context.Context, githubID int64) (store.Repo, bool, error) {
	repo, err := w.store.RepoByGitHubID(ctx, githubID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Repo{}, false, nil
	}
	if err != nil {
		return store.Repo{}, false, err
	}
	return repo, true, nil
}
