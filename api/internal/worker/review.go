package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/jackc/pgx/v5"
)

type reviewEvent struct {
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Action      string            `json:"action"`
	Review      github.Review     `json:"review"`
	Repository  github.Repository `json:"repository"`
	PullRequest struct {
		Number int `json:"number"`
	} `json:"pull_request"`
}

func (w *Worker) handleReview(ctx context.Context, payload []byte) error {
	var ev reviewEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return fmt.Errorf("decode pull_request_review event: %w", err)
	}

	repo, ok, err := w.repoFromPayload(ctx, ev.Repository.ID, ev.Installation.ID)
	if err != nil || !ok {
		return err
	}

	return w.syncReview(ctx, repo, ev.PullRequest.Number, ev.Review)
}

func (w *Worker) syncReview(ctx context.Context, repo store.Repo, number int, review github.Review) error {
	prID, err := w.store.PullRequestIDByNumber(ctx, repo.ID, number)
	if errors.Is(err, store.ErrNotFound) {
		if w.gh == nil {
			return errors.New("GitHub App is required to fetch a review's missing pull request")
		}
		pr, fetchErr := w.gh.GetPullRequest(ctx, repo.InstallationID, repo.Owner, repo.Name, number)
		if fetchErr != nil {
			return errors.New("review pull request sync failed")
		}
		if err := w.syncPullRequest(ctx, repo, pr); err != nil {
			return err
		}
		prID, err = w.store.PullRequestIDByNumber(ctx, repo.ID, number)
	}
	if err != nil {
		return err
	}

	submitted := review.SubmittedAt
	if submitted.IsZero() {
		submitted = time.Now()
	}
	return w.store.WithActiveRepo(ctx, repo, func(tx pgx.Tx) error {
		return store.UpsertReviewTx(ctx, tx, store.UpsertReviewInput{
			WorkspaceID:   repo.WorkspaceID,
			PullRequestID: prID,
			GitHubID:      review.ID,
			ReviewerLogin: review.ReviewerLogin,
			State:         review.State,
			SubmittedAt:   submitted,
		})
	})
}

// timePtr returns nil for the zero time, so an absent GitHub timestamp is
// stored as NULL rather than as year zero.
func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}
