package store

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// EvidenceRef is a reference to proof of work in the form a person or an agent
// actually has: a pull request URL, an owner/repo#number shorthand, or a
// commit sha. A UUID is what the database uses, not what anyone has to hand
// after finishing a piece of work.
type EvidenceRef struct {
	// Kind is "pull_request" or "commit" once resolved.
	Kind string    `json:"kind"`
	ID   uuid.UUID `json:"id"`
	SHA  string    `json:"sha,omitempty"`
	URL  string    `json:"url,omitempty"`
}

var (
	// https://github.com/owner/repo/pull/42, tolerating a trailing path or
	// query such as /files or #discussion.
	prURLRe = regexp.MustCompile(`(?i)^https?://[^/]+/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$`)
	// owner/repo#42, the shorthand people paste in chat.
	prShortRe = regexp.MustCompile(`^([\w.-]+)/([\w.-]+)#(\d+)$`)
	// A full or abbreviated commit sha. Seven is git's own minimum for an
	// unambiguous short sha.
	shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
	// https://github.com/owner/repo/commit/<sha>
	commitURLRe = regexp.MustCompile(`(?i)^https?://[^/]+/([^/]+)/([^/]+)/commit/([0-9a-f]{7,40})(?:[/?#].*)?$`)
)

// ResolveEvidence turns a human reference into a stored row in this workspace.
//
// It never creates the pull request or commit it is asked for. A reference to
// something that has not synced yet is ErrNotFound, because inventing a row
// would put unverified evidence into the record of someone's work.
func (s *Store) ResolveEvidence(ctx context.Context, workspaceID uuid.UUID, reference string) (EvidenceRef, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return EvidenceRef{}, ErrNotFound
	}

	if m := prURLRe.FindStringSubmatch(reference); m != nil {
		return s.pullRequestByNumber(ctx, workspaceID, m[1], m[2], m[3])
	}
	if m := prShortRe.FindStringSubmatch(reference); m != nil {
		return s.pullRequestByNumber(ctx, workspaceID, m[1], m[2], m[3])
	}
	if m := commitURLRe.FindStringSubmatch(reference); m != nil {
		return s.commitBySHA(ctx, workspaceID, m[3])
	}
	if shaRe.MatchString(reference) {
		return s.commitBySHA(ctx, workspaceID, reference)
	}
	return EvidenceRef{}, ErrNotFound
}

func (s *Store) pullRequestByNumber(ctx context.Context, workspaceID uuid.UUID, owner, name, number string) (EvidenceRef, error) {
	var ref EvidenceRef
	err := s.pool.QueryRow(ctx, `
		SELECT p.id, p.html_url
		FROM pull_request p JOIN repo r ON r.id = p.repo_id
		WHERE p.workspace_id = $1 AND lower(r.owner) = lower($2)
		  AND lower(r.name) = lower($3) AND p.number = $4::int`,
		workspaceID, owner, name, number).Scan(&ref.ID, &ref.URL)
	if err != nil {
		return EvidenceRef{}, mapErr(err)
	}
	ref.Kind = "pull_request"
	return ref, nil
}

// commitBySHA accepts an abbreviated sha. An abbreviation that matches more
// than one commit is rejected rather than resolved arbitrarily, because
// attaching the wrong commit as proof of work is worse than attaching none.
func (s *Store) commitBySHA(ctx context.Context, workspaceID uuid.UUID, sha string) (EvidenceRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sha, html_url FROM commit_ref
		WHERE workspace_id = $1 AND sha LIKE lower($2) || '%'
		LIMIT 2`, workspaceID, sha)
	if err != nil {
		return EvidenceRef{}, err
	}
	defer rows.Close()

	var found []EvidenceRef
	for rows.Next() {
		var ref EvidenceRef
		if err := rows.Scan(&ref.SHA, &ref.URL); err != nil {
			return EvidenceRef{}, err
		}
		ref.Kind = "commit"
		found = append(found, ref)
	}
	if err := rows.Err(); err != nil {
		return EvidenceRef{}, err
	}
	switch len(found) {
	case 0:
		return EvidenceRef{}, ErrNotFound
	case 1:
		return found[0], nil
	default:
		return EvidenceRef{}, ErrAmbiguousReference
	}
}

// AttachEvidenceToIssue records proof of work against a ticket.
//
// It deliberately does not touch the issue's status. Attaching proof that work
// happened is not the same as deciding the work is finished, and that decision
// belongs to the person, never to a branch name or a merge.
func (s *Store) AttachEvidenceToIssue(ctx context.Context, workspaceID, issueID, actorID uuid.UUID, ref EvidenceRef) error {
	switch ref.Kind {
	case "pull_request":
		return s.ManualLink(ctx, workspaceID, issueID, ref.ID, actorID)
	case "commit":
		return s.InTx(ctx, func(tx pgx.Tx) error {
			var key string
			if err := tx.QueryRow(ctx,
				`SELECT key FROM issue WHERE id = $1 AND workspace_id = $2`,
				issueID, workspaceID).Scan(&key); err != nil {
				return mapErr(err)
			}
			tag, err := tx.Exec(ctx, `
				UPDATE commit_ref SET issue_id = $3
				WHERE workspace_id = $1 AND sha = $2 AND issue_id IS DISTINCT FROM $3`,
				workspaceID, ref.SHA, issueID)
			if err != nil {
				return err
			}
			// Re-attaching the same commit is not an error and records no
			// second activity row, so a repeated call reads as one attachment.
			if tag.RowsAffected() == 0 {
				return nil
			}
			return RecordActivity(ctx, tx, ActivityInput{
				WorkspaceID: workspaceID, ActorID: actorID,
				Verb: VerbAttachedCommit, TargetType: "issue", TargetID: issueID,
				Metadata: map[string]any{
					"sha": ref.SHA, "html_url": ref.URL, "key": key,
				},
			})
		})
	default:
		return ErrNotFound
	}
}
