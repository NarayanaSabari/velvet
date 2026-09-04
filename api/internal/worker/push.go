package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/linker"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type pushEvent struct {
	Ref        string            `json:"ref"`
	Repository github.Repository `json:"repository"`
	Commits    []pushCommit      `json:"commits"`
}

type pushCommit struct {
	ID        string    `json:"id"`
	Message   string    `json:"message"`
	URL       string    `json:"url"`
	Timestamp time.Time `json:"timestamp"`
	Author    struct {
		Username string `json:"username"`
		Name     string `json:"name"`
	} `json:"author"`
}

func (w *Worker) handlePush(ctx context.Context, payload []byte) error {
	var ev pushEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return fmt.Errorf("decode push event: %w", err)
	}

	repo, ok, err := w.repoFromPayload(ctx, ev.Repository.ID)
	if err != nil || !ok {
		return err
	}

	branch := strings.TrimPrefix(ev.Ref, "refs/heads/")
	prefix, err := w.store.WorkspaceIssuePrefix(ctx, repo.WorkspaceID)
	if err != nil {
		return err
	}

	// A commit is attributed to the issue its branch names. Commit messages
	// are not searched: a message mentioning an issue in passing would drag
	// unrelated work onto that issue's timeline.
	var issueID *uuid.UUID
	if matches := linker.Find(prefix, branch, "", ""); len(matches) > 0 {
		id, err := w.store.IssueIDByKey(ctx, repo.WorkspaceID, matches[0].Key)
		switch {
		case errors.Is(err, store.ErrNotFound):
			// Unresolvable key: the commit is still recorded, unattributed.
		case err != nil:
			return err
		default:
			issueID = &id
		}
	}

	for _, c := range ev.Commits {
		author := c.Author.Username
		if author == "" {
			author = c.Author.Name
		}
		if err := w.store.UpsertCommit(ctx, store.UpsertCommitInput{
			SHA:         c.ID,
			WorkspaceID: repo.WorkspaceID,
			RepoID:      repo.ID,
			IssueID:     issueID,
			Branch:      branch,
			Message:     c.Message,
			AuthorLogin: author,
			HTMLURL:     c.URL,
			CommittedAt: c.Timestamp,
		}); err != nil {
			return err
		}
	}
	return nil
}
