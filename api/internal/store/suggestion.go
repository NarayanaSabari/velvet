package store

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Suggested links are Jev's guess at which open issue a piece of unlinked
// work belongs to. Two kinds of work get one: a pull request that matched no
// issue key, and a note logged against a project rather than a ticket.
//
// A suggestion is never applied on its own. A person accepts it, which links
// the PR or files the note under the issue, or dismisses it. Neither ever
// changes an issue's status.

const (
	SuggestionPullRequest = "pull_request"
	SuggestionNote        = "note"

	VerbFiledEntry = "filed_entry"

	// MaxSuggestionCandidates bounds the open issues offered per question.
	// Ranking puts the likeliest first, so the cap trims only the least
	// related issues.
	MaxSuggestionCandidates = 40
	// Field caps keep one request well inside Jev's per-question context
	// while still giving it the whole story of the work.
	maxWorkBody       = 8000
	maxIssueBody      = 1500
	maxProjectBody    = 1000
	maxCommitMessages = 20
)

// LinkSuggestion is what the Unlinked work page shows beside one item.
type LinkSuggestion struct {
	ID          uuid.UUID `json:"id"`
	IssueKey    string    `json:"issue_key"`
	IssueTitle  string    `json:"issue_title"`
	IssueStatus string    `json:"issue_status"`
	Probability float64   `json:"probability"`
}

// SuggestionCandidate is one open issue offered to Jev.
type SuggestionCandidate struct {
	ID          uuid.UUID `json:"-"`
	Key         string    `json:"key"`
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Status      string    `json:"status"`
	Project     string    `json:"project,omitempty"`
	Milestone   string    `json:"milestone,omitempty"`
	Assignee    string    `json:"assignee,omitempty"`
	Labels      []string  `json:"labels,omitempty"`
	UpdatedAt   string    `json:"updated_at"`
}

// SuggestionProject describes the project the work is already filed under.
type SuggestionProject struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// SuggestionWork is the work being filed, in the shape Jev reads.
type SuggestionWork struct {
	Kind       string             `json:"kind"`
	Title      string             `json:"title,omitempty"`
	Body       string             `json:"body,omitempty"`
	Branch     string             `json:"branch,omitempty"`
	Repository string             `json:"repository,omitempty"`
	Number     int                `json:"number,omitempty"`
	State      string             `json:"state,omitempty"`
	Author     string             `json:"author,omitempty"`
	WrittenBy  string             `json:"written_by,omitempty"`
	NoteKind   string             `json:"note_kind,omitempty"`
	Commits    []string           `json:"commit_messages,omitempty"`
	Project    *SuggestionProject `json:"project,omitempty"`
	CreatedAt  string             `json:"created_at,omitempty"`
}

// SuggestionSubject is one piece of work whose suggestion is missing or stale.
type SuggestionSubject struct {
	Kind        string
	SubjectID   uuid.UUID
	WorkspaceID uuid.UUID
	// Fingerprint identifies the work as it was asked about. Storing it with
	// the answer is what stops unchanged work from being sent again.
	Fingerprint string
	Work        SuggestionWork
	// ProjectID and AuthorID rank candidates; they are not sent.
	ProjectID *uuid.UUID
	AuthorID  *uuid.UUID
}

// The fingerprint covers what Jev reads about the work. PR state is left out
// on purpose: merging does not change what the work is about.
const prFingerprint = `md5(concat_ws(E'\x1f', p.title, p.body, p.head_ref))`

// notPromoted excludes a project note that was already turned into a ticket.
const notPromoted = `NOT EXISTS (SELECT 1 FROM activity a
	    WHERE a.workspace_id = c.workspace_id AND a.verb = 'promoted_entry'
	      AND a.metadata->>'comment_id' = c.id::text)`

// Both queries return the same columns, so one scan reads either kind.
var stalePRs = `
	SELECT 'pull_request', p.id, p.workspace_id, ` + prFingerprint + `,
	       p.title, left(p.body, $2), p.head_ref, r.owner || '/' || r.name, p.number, p.state::text,
	       concat_ws(' ', NULLIF(p.author_login, ''), '(' || NULLIF(u.name, '') || ')'),
	       '', '',
	       COALESCE(to_char(COALESCE(p.gh_created_at, p.gh_updated_at), 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'), ''),
	       pr.id, COALESCE(pr.key, ''), COALESCE(pr.name, ''), left(COALESCE(pr.description, ''), $3),
	       p.author_id
	FROM pull_request p
	JOIN workspace w ON w.id = p.workspace_id AND w.jev_suggestions
	JOIN repo r ON r.id = p.repo_id
	LEFT JOIN project pr ON pr.id = r.project_id
	LEFT JOIN app_user u ON u.id = p.author_id
	LEFT JOIN link_suggestion s ON s.pull_request_id = p.id
	WHERE NOT EXISTS (SELECT 1 FROM pr_link l WHERE l.pull_request_id = p.id)
	  AND ` + staleCondition(prFingerprint) + `
	ORDER BY s.id IS NOT NULL, p.gh_updated_at DESC NULLS LAST
	LIMIT $1`

var staleNotes = `
	SELECT 'note', c.id, c.workspace_id, md5(c.body),
	       '', left(c.body, $2), '', '', 0, '',
	       COALESCE(NULLIF(u.name, ''), u.github_login, ''),
	       c.source, COALESCE(c.kind, ''),
	       to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	       pr.id, pr.key, pr.name, left(pr.description, $3),
	       c.author_id
	FROM comment c
	JOIN workspace w ON w.id = c.workspace_id AND w.jev_suggestions
	JOIN project pr ON pr.id = c.target_id
	JOIN app_user u ON u.id = c.author_id
	LEFT JOIN link_suggestion s ON s.comment_id = c.id
	WHERE c.target_type = 'project' AND c.parent_id IS NULL AND c.deleted_at IS NULL
	  AND ` + notPromoted + `
	  AND ` + staleCondition("md5(c.body)") + `
	ORDER BY s.id IS NOT NULL, c.created_at DESC
	LIMIT $1`

// staleCondition selects work that was never asked about, work that changed
// since, a recent "no match" answer given before a newer issue existed, and
// a suggestion whose issue has since closed. Accepted work is never re-asked,
// and old "no match" answers are left alone so every new issue does not
// re-send an organisation's whole history.
func staleCondition(fingerprint string) string {
	return `s.accepted_at IS NULL AND (s.id IS NULL
	    OR s.fingerprint <> ` + fingerprint + `
	    OR (s.issue_id IS NULL AND s.updated_at > now() - interval '30 days' AND EXISTS (
	          SELECT 1 FROM issue n WHERE n.workspace_id = s.workspace_id
	            AND n.status NOT IN ('done', 'cancelled') AND n.created_at > s.updated_at))
	    OR (s.issue_id IS NOT NULL AND s.dismissed_at IS NULL AND EXISTS (
	          SELECT 1 FROM issue o WHERE o.id = s.issue_id AND o.status IN ('done', 'cancelled'))))`
}

// StaleSuggestionSubjects returns up to limit items of each kind that need a
// suggestion, never-asked items first and then newest first.
func (s *Store) StaleSuggestionSubjects(ctx context.Context, limit int) ([]SuggestionSubject, error) {
	var out []SuggestionSubject
	for _, q := range []string{stalePRs, staleNotes} {
		subjects, err := s.querySubjects(ctx, q, limit, maxWorkBody, maxProjectBody)
		if err != nil {
			return nil, err
		}
		out = append(out, subjects...)
	}
	for i := range out {
		if out[i].Kind != SuggestionPullRequest {
			continue
		}
		commits, err := s.prCommitMessages(ctx, out[i].SubjectID)
		if err != nil {
			return nil, err
		}
		out[i].Work.Commits = commits
	}
	return out, nil
}

func (s *Store) querySubjects(ctx context.Context, q string, args ...any) ([]SuggestionSubject, error) {
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SuggestionSubject
	for rows.Next() {
		var sub SuggestionSubject
		var source, noteKind, projectKey, projectName, projectDesc string
		var projectID *uuid.UUID
		if err := rows.Scan(&sub.Kind, &sub.SubjectID, &sub.WorkspaceID, &sub.Fingerprint,
			&sub.Work.Title, &sub.Work.Body, &sub.Work.Branch, &sub.Work.Repository, &sub.Work.Number, &sub.Work.State,
			&sub.Work.Author, &source, &noteKind, &sub.Work.CreatedAt,
			&projectID, &projectKey, &projectName, &projectDesc, &sub.AuthorID); err != nil {
			return nil, err
		}
		if sub.Kind == SuggestionPullRequest {
			sub.Work.Kind = "GitHub pull request"
		} else {
			sub.Work.Kind = "work log note"
			sub.Work.WrittenBy = map[string]string{"agent": "a coding agent", "human": "a person"}[source]
			sub.Work.NoteKind = noteKind
		}
		if projectID != nil {
			sub.ProjectID = projectID
			sub.Work.Project = &SuggestionProject{Key: projectKey, Name: projectName, Description: projectDesc}
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

// prCommitMessages is the commits pushed to a PR's branch. Commit messages
// often say what a terse PR title does not.
func (s *Store) prCommitMessages(ctx context.Context, prID uuid.UUID) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT left(split_part(c.message, E'\n', 1), 200)
		FROM pull_request p
		JOIN commit_ref c ON c.repo_id = p.repo_id AND c.branch = p.head_ref AND p.head_ref <> ''
		WHERE p.id = $1
		ORDER BY c.committed_at DESC
		LIMIT $2`, prID, maxCommitMessages)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SuggestionCandidates lists the organisation's open issues, ranked so the
// likeliest homes come first: the work's own project, then issues assigned to
// its author, then the most recently active.
func (s *Store) SuggestionCandidates(ctx context.Context, workspaceID uuid.UUID, projectID, authorID *uuid.UUID) ([]SuggestionCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT i.id, i.key, i.title, left(i.description, $4), i.status::text,
		       COALESCE(p.name, ''), COALESCE(m.name, ''),
		       COALESCE(NULLIF(u.name, ''), u.github_login, ''),
		       COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM issue_label il
		                 JOIN label l ON l.id = il.label_id WHERE il.issue_id = i.id), '{}'),
		       to_char(i.updated_at, 'YYYY-MM-DD')
		FROM issue i
		LEFT JOIN project p ON p.id = i.project_id
		LEFT JOIN milestone m ON m.id = i.milestone_id
		LEFT JOIN app_user u ON u.id = i.assignee_id
		WHERE i.workspace_id = $1 AND i.status NOT IN ('done', 'cancelled')
		ORDER BY (i.project_id IS NOT DISTINCT FROM $2 AND $2::uuid IS NOT NULL) DESC,
		         (i.assignee_id IS NOT DISTINCT FROM $3 AND $3::uuid IS NOT NULL) DESC,
		         i.updated_at DESC, i.number DESC
		LIMIT $5`, workspaceID, projectID, authorID, maxIssueBody, MaxSuggestionCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SuggestionCandidate{}
	for rows.Next() {
		var c SuggestionCandidate
		if err := rows.Scan(&c.ID, &c.Key, &c.Title, &c.Description, &c.Status,
			&c.Project, &c.Milestone, &c.Assignee, &c.Labels, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SaveSuggestionInput is one answer. A nil IssueID records "no match", which
// still stops the same work from being asked about again.
type SaveSuggestionInput struct {
	Kind        string
	SubjectID   uuid.UUID
	WorkspaceID uuid.UUID
	IssueID     *uuid.UUID
	Probability *float64
	Model       string
	Fingerprint string
}

// SaveSuggestion stores the latest answer for one piece of work. A dismissal
// survives a re-ask that lands on the same issue, so a person is not shown a
// suggestion they already turned down. Accepted work is left alone.
func (s *Store) SaveSuggestion(ctx context.Context, in SaveSuggestionInput) error {
	column := "pull_request_id"
	if in.Kind == SuggestionNote {
		column = "comment_id"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO link_suggestion (workspace_id, `+column+`, issue_id, probability, model, fingerprint)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (`+column+`) DO UPDATE SET
		    issue_id = EXCLUDED.issue_id,
		    probability = EXCLUDED.probability,
		    model = EXCLUDED.model,
		    fingerprint = EXCLUDED.fingerprint,
		    updated_at = now(),
		    dismissed_at = CASE WHEN link_suggestion.issue_id IS NOT DISTINCT FROM EXCLUDED.issue_id
		                        THEN link_suggestion.dismissed_at END,
		    dismissed_by = CASE WHEN link_suggestion.issue_id IS NOT DISTINCT FROM EXCLUDED.issue_id
		                        THEN link_suggestion.dismissed_by END
		WHERE link_suggestion.accepted_at IS NULL`,
		in.WorkspaceID, in.SubjectID, in.IssueID, in.Probability, in.Model, in.Fingerprint)
	return err
}

// openSuggestion is the condition for a suggestion worth showing: an
// answer that names an issue still open, not dismissed or accepted, in an
// organisation that has suggestions on.
const openSuggestion = `s.issue_id IS NOT NULL AND s.dismissed_at IS NULL AND s.accepted_at IS NULL
	AND i.status NOT IN ('done', 'cancelled') AND w.jev_suggestions`

// PullRequestSuggestions returns the open suggestion for each listed PR.
func (s *Store) PullRequestSuggestions(ctx context.Context, workspaceID uuid.UUID, prIDs []uuid.UUID) (map[uuid.UUID]LinkSuggestion, error) {
	out := map[uuid.UUID]LinkSuggestion{}
	if len(prIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.pull_request_id, s.id, i.key, i.title, i.status::text, COALESCE(s.probability, 0)
		FROM link_suggestion s
		JOIN issue i ON i.id = s.issue_id
		JOIN workspace w ON w.id = s.workspace_id
		WHERE s.workspace_id = $1 AND s.pull_request_id = ANY($2) AND `+openSuggestion,
		workspaceID, prIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var prID uuid.UUID
		var sg LinkSuggestion
		if err := rows.Scan(&prID, &sg.ID, &sg.IssueKey, &sg.IssueTitle, &sg.IssueStatus, &sg.Probability); err != nil {
			return nil, err
		}
		out[prID] = sg
	}
	return out, rows.Err()
}

// SuggestedNote is a project note with an open suggestion of where to file it.
type SuggestedNote struct {
	Comment    Comment        `json:"comment"`
	ProjectKey string         `json:"project_key"`
	Project    string         `json:"project_name"`
	Suggestion LinkSuggestion `json:"suggestion"`
}

// SuggestedNotes lists project notes that Jev thinks belong on an issue.
// Notes without a suggestion are not listed: logging against a project is a
// normal place for work to live, not a gap to close.
func (s *Store) SuggestedNotes(ctx context.Context, workspaceID uuid.UUID, limit int) ([]SuggestedNote, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+commentCols+`, pr.key, pr.name,
		       s.id, i.key, i.title, i.status::text, COALESCE(s.probability, 0)
		FROM link_suggestion s
		JOIN comment c ON c.id = s.comment_id
		JOIN app_user u ON u.id = c.author_id
		JOIN project pr ON pr.id = c.target_id
		JOIN issue i ON i.id = s.issue_id
		JOIN workspace w ON w.id = s.workspace_id
		WHERE s.workspace_id = $1 AND c.target_type = 'project' AND c.deleted_at IS NULL
		  AND `+notPromoted+`
		  AND `+openSuggestion+`
		ORDER BY c.created_at DESC
		LIMIT $2`, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SuggestedNote{}
	for rows.Next() {
		var n SuggestedNote
		sg := &n.Suggestion
		if err := scanCommentRow(rows, &n.Comment, &n.ProjectKey, &n.Project,
			&sg.ID, &sg.IssueKey, &sg.IssueTitle, &sg.IssueStatus, &sg.Probability); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// ErrSuggestionClosed is a suggestion that is no longer open: already
// accepted or dismissed, or its issue has closed.
var ErrSuggestionClosed = errors.New("suggestion is no longer open")

// AcceptSuggestion applies one suggestion on a person's behalf: a PR is linked
// to the issue as evidence, and a note is filed under the issue with its
// replies. The issue's status never changes.
func (s *Store) AcceptSuggestion(ctx context.Context, workspaceID, suggestionID, actorID uuid.UUID) (string, error) {
	var key string
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		var prID, commentID, issueID *uuid.UUID
		var dismissed, accepted bool
		err := tx.QueryRow(ctx, `
			SELECT pull_request_id, comment_id, issue_id, dismissed_at IS NOT NULL, accepted_at IS NOT NULL
			FROM link_suggestion WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
			workspaceID, suggestionID).Scan(&prID, &commentID, &issueID, &dismissed, &accepted)
		if err != nil {
			return mapErr(err)
		}
		if issueID == nil || dismissed || accepted {
			return ErrSuggestionClosed
		}
		var status string
		if err := tx.QueryRow(ctx, `SELECT key, status::text FROM issue WHERE id = $1 AND workspace_id = $2`,
			*issueID, workspaceID).Scan(&key, &status); err != nil {
			return mapErr(err)
		}
		if status == "done" || status == "cancelled" {
			return ErrSuggestionClosed
		}

		if prID != nil {
			if _, err := LinkPRTx(ctx, tx, workspaceID, *prID, *issueID, "suggested", false, &actorID); err != nil {
				return err
			}
		} else if err := fileNoteTx(ctx, tx, workspaceID, *commentID, *issueID, key, actorID); err != nil {
			return err
		}

		_, err = tx.Exec(ctx, `
			UPDATE link_suggestion SET accepted_at = now(), accepted_by = $3, updated_at = now()
			WHERE workspace_id = $1 AND id = $2`, workspaceID, suggestionID, actorID)
		return err
	})
	return key, err
}

// fileNoteTx moves a project note and its replies onto an issue. The note
// keeps its author, time, and source; only where it lives changes.
func fileNoteTx(ctx context.Context, tx pgx.Tx, workspaceID, commentID, issueID uuid.UUID, key string, actorID uuid.UUID) error {
	var projectKey, body string
	err := tx.QueryRow(ctx, `
		SELECT p.key, c.body FROM comment c JOIN project p ON p.id = c.target_id
		WHERE c.workspace_id = $1 AND c.id = $2 AND c.target_type = 'project' AND c.deleted_at IS NULL
		FOR UPDATE OF c`, workspaceID, commentID).Scan(&projectKey, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSuggestionClosed
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE comment SET target_type = 'issue', target_id = $3
		WHERE workspace_id = $1 AND (id = $2 OR parent_id = $2)`,
		workspaceID, commentID, issueID); err != nil {
		return err
	}
	return RecordActivity(ctx, tx, ActivityInput{
		WorkspaceID: workspaceID, ActorID: actorID,
		Verb: VerbFiledEntry, TargetType: "issue", TargetID: issueID,
		Metadata: map[string]any{
			"key":         key,
			"comment_id":  commentID.String(),
			"project_key": projectKey,
			"excerpt":     excerpt(strings.TrimSpace(body)),
		},
	})
}

// DismissSuggestion hides one suggestion. The same work is suggested again
// only if it changes or Jev later picks a different issue.
func (s *Store) DismissSuggestion(ctx context.Context, workspaceID, suggestionID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE link_suggestion SET dismissed_at = now(), dismissed_by = $3, updated_at = now()
			WHERE workspace_id = $1 AND id = $2 AND issue_id IS NOT NULL
			  AND dismissed_at IS NULL AND accepted_at IS NULL`,
			workspaceID, suggestionID, actorID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM link_suggestion WHERE workspace_id = $1 AND id = $2)`,
				workspaceID, suggestionID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			return ErrSuggestionClosed
		}
		return nil
	})
}

// JevSuggestionsEnabled reports the organisation's setting.
func (s *Store) JevSuggestionsEnabled(ctx context.Context, workspaceID uuid.UUID) (bool, error) {
	var enabled bool
	err := s.pool.QueryRow(ctx, `SELECT jev_suggestions FROM workspace WHERE id = $1`, workspaceID).Scan(&enabled)
	return enabled, mapErr(err)
}

// SetJevSuggestions turns suggestions on or off for one organisation. Turning
// them off hides existing suggestions and stops new requests at once.
func (s *Store) SetJevSuggestions(ctx context.Context, workspaceID, actorID uuid.UUID, enabled bool) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE workspace SET jev_suggestions = $2 WHERE id = $1`, workspaceID, enabled)
		return err
	})
}
