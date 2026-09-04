package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type reviewEvent struct {
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

	repo, ok, err := w.repoFromPayload(ctx, ev.Repository.ID)
	if err != nil || !ok {
		return err
	}

	prID, err := w.store.PullRequestIDByNumber(ctx, repo.ID, ev.PullRequest.Number)
	if errors.Is(err, store.ErrNotFound) {
		// The PR event may simply not have arrived yet. Skipping rather than
		// failing lets reconciliation pick this up instead of burning retries.
		return nil
	}
	if err != nil {
		return err
	}

	submitted := ev.Review.SubmittedAt
	if submitted.IsZero() {
		submitted = time.Now()
	}
	return w.store.UpsertReview(ctx, store.UpsertReviewInput{
		WorkspaceID:   repo.WorkspaceID,
		PullRequestID: prID,
		GitHubID:      ev.Review.ID,
		ReviewerLogin: ev.Review.ReviewerLogin,
		State:         ev.Review.State,
		SubmittedAt:   submitted,
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
