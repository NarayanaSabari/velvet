package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
}

// handleInstallation keeps the installation record current, including
// suspension. A suspended installation still has repositories linked, so the
// history stays readable even while the App cannot call GitHub.
func (w *Worker) handleInstallation(ctx context.Context, payload []byte) error {
	var ev installationEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return fmt.Errorf("decode installation event: %w", err)
	}
	if ev.Installation.ID == 0 {
		return nil
	}
	job, check, err := w.store.InstallationEvent(ctx, ev.Installation.ID, ev.Installation.Account.Login, ev.Action)
	if err != nil {
		return err
	}
	if !check {
		return nil
	}
	return w.syncInstallationState(ctx, job)
}

func (w *Worker) syncInstallationState(ctx context.Context, job store.InstallationSync) error {
	current, err := w.store.InstallationStateCurrent(ctx, job)
	if err != nil {
		return errors.New("installation state sync failed")
	}
	if !current {
		return nil
	}
	fail := func() error {
		if err := w.store.FailInstallationSync(ctx, job, "sync_failed"); err != nil {
			return errors.New("could not record installation sync failure")
		}
		return errors.New("installation state sync failed")
	}
	if w.gh == nil {
		return fail()
	}
	suspended, err := w.gh.InstallationSuspended(ctx, job.InstallationID)
	if err != nil {
		return fail()
	}
	err = w.store.ApplyInstallationState(ctx, job, suspended)
	if errors.Is(err, store.ErrStaleInstallationSync) {
		return nil
	}
	if err != nil {
		return fail()
	}
	return nil
}

func (w *Worker) syncInstallationRepos(ctx context.Context, job store.InstallationSync) error {
	current, err := w.store.InstallationSyncCurrent(ctx, job)
	if err != nil {
		return errors.New("installation sync failed")
	}
	if !current {
		return nil
	}
	fail := func(code string) error {
		if err := w.store.FailInstallationSync(ctx, job, code); err != nil {
			return errors.New("could not record installation sync failure")
		}
		return errors.New(code)
	}
	if w.gh == nil {
		return fail("sync_failed")
	}
	repos, err := w.gh.ListInstallationRepositories(ctx, job.InstallationID)
	if err != nil {
		return fail("sync_failed")
	}
	err = w.store.ApplyInstallationRepos(ctx, job, repos)
	if errors.Is(err, store.ErrStaleInstallationSync) {
		return nil
	}
	if errors.Is(err, store.ErrRepositoryConflict) {
		return fail("repository_conflict")
	}
	if err != nil {
		return fail("sync_failed")
	}
	// Initial evidence backfill runs immediately, using preserved sync history
	// for repositories reconnected within the same organisation.
	for _, item := range repos {
		current, err := w.store.InstallationSyncCurrent(ctx, job)
		if err != nil {
			return fail("sync_failed")
		}
		if !current {
			return nil
		}
		repo, err := w.store.RepoByGitHubID(ctx, item.ID)
		if err != nil {
			return fail("sync_failed")
		}
		if err := w.reconcileRepo(ctx, repo); err != nil {
			return fail("sync_failed")
		}
	}
	return nil
}
