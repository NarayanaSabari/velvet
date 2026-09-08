package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/linker"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// pullRequestEvent is the slice of GitHub's pull_request payload this worker
// uses. Everything else in the delivery is kept in github_event, so nothing is
// lost by not parsing it here.
type pullRequestEvent struct {
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Action      string             `json:"action"`
	PullRequest github.PullRequest `json:"pull_request"`
	Repository  github.Repository  `json:"repository"`
}

func (w *Worker) handlePullRequest(ctx context.Context, payload []byte) error {
	var ev pullRequestEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return fmt.Errorf("decode pull_request event: %w", err)
	}

	repo, ok, err := w.repoFromPayload(ctx, ev.Repository.ID, ev.Installation.ID)
	if err != nil || !ok {
		return err
	}
	return w.syncPullRequest(ctx, repo, ev.PullRequest)
}

// syncPullRequest mirrors one PR and links it to every issue it references.
// The webhook path and the reconciler both go through here, so a recovered
// delivery produces exactly what the live one would have.
//
// It never sets issue.status. Attaching or merging a PR records evidence and
// activity; the UI later prompts a human, and the human decides.
func (w *Worker) syncPullRequest(ctx context.Context, repo store.Repo, pr github.PullRequest) error {
	prefix, err := w.store.WorkspaceIssuePrefix(ctx, repo.WorkspaceID)
	if err != nil {
		return err
	}
	return w.store.WithActiveRepo(ctx, repo, func(tx pgx.Tx) error {
		stored, err := store.UpsertPullRequestTx(ctx, tx, store.UpsertPRInput{
			WorkspaceID: repo.WorkspaceID,
			RepoID:      repo.ID,
			Number:      pr.Number,
			Title:       pr.Title,
			State:       pr.State,
			Draft:       pr.Draft,
			AuthorLogin: pr.AuthorLogin,
			HeadRef:     pr.HeadRef,
			Body:        pr.Body,
			Additions:   pr.Additions,
			Deletions:   pr.Deletions,
			HTMLURL:     pr.HTMLURL,
			MergedAt:    pr.MergedAt,
			ClosedAt:    pr.ClosedAt,
			GHCreatedAt: timePtr(pr.CreatedAt),
			GHUpdatedAt: timePtr(pr.UpdatedAt),
		})
		if err != nil {
			return err
		}

		for _, match := range linker.Find(prefix, pr.HeadRef, pr.Title, pr.Body) {
			var issueID uuid.UUID
			err := tx.QueryRow(ctx, `SELECT id FROM issue WHERE workspace_id=$1 AND key=$2`, repo.WorkspaceID, match.Key).Scan(&issueID)
			if errors.Is(err, pgx.ErrNoRows) {
				// A key that resolves to nothing is a typo or another workspace's
				// issue. The PR stays visible through UnlinkedPullRequests rather
				// than failing the delivery.
				continue
			}
			if err != nil {
				return err
			}
			// Attribute the link to the PR's author when that GitHub login maps to
			// a member. Otherwise the feed reads "Someone attached PR #42", which
			// hides the one person who most obviously did the work.
			if _, err := store.LinkPRTx(ctx, tx, repo.WorkspaceID, stored.ID, issueID,
				match.Source, match.Closing, stored.AuthorID); err != nil {
				return err
			}
		}
		return nil
	})
}
