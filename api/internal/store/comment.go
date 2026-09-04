package store

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Comment is the progress-log entry attached to an issue or a milestone. The
// full comment store lands with the comment endpoints; the type lives here so
// that a milestone row can carry its most recent comment.
type Comment struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	TargetType  string     `json:"target_type"`
	TargetID    uuid.UUID  `json:"target_id"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Author      User       `json:"author"`
	Body        string     `json:"body"`
	CreatedAt   string     `json:"created_at"`
	EditedAt    *string    `json:"edited_at"`
	DeletedAt   *string    `json:"deleted_at"`
	Replies     []Comment  `json:"replies,omitempty"`
}

type CreateCommentInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	TargetType  string
	TargetID    uuid.UUID
	ParentID    *uuid.UUID
	Body        string
}

func ValidCommentTarget(t string) bool {
	return t == "issue" || t == "milestone"
}

// excerptLen keeps the feed metadata short enough to render in a list without
// carrying a whole comment body into every activity row.
const excerptLen = 140

const commentCols = `c.id, c.workspace_id, c.target_type::text, c.target_id, c.parent_id,
	c.body,
	to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(c.edited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(c.deleted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	u.id, u.github_id, u.github_login, u.name, u.avatar_url`

// scanCommentRow reads commentCols, plus any extra destinations a caller has
// appended to the same select.
func scanCommentRow(row pgx.Row, c *Comment, extra ...any) error {
	dst := []any{&c.ID, &c.WorkspaceID, &c.TargetType, &c.TargetID, &c.ParentID,
		&c.Body, &c.CreatedAt, &c.EditedAt, &c.DeletedAt,
		&c.Author.ID, &c.Author.GitHubID, &c.Author.GitHubLogin,
		&c.Author.Name, &c.Author.AvatarURL}
	return mapCommentErr(row.Scan(append(dst, extra...)...))
}

// mapCommentErr translates the depth-guard trigger, which reports an illegal
// reply as a plain Postgres exception, into a sentinel the handlers turn into
// a 400 rather than a 500.
func mapCommentErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && strings.Contains(pgErr.Message, "one level") {
		return ErrInvalidNesting
	}
	return mapErr(err)
}

// CreateComment writes the comment, its activity row, and its mentions in one
// transaction, so the feed and the inbox can never disagree with the log.
func (s *Store) CreateComment(ctx context.Context, in CreateCommentInput) (Comment, error) {
	var out Comment
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := checkCommentTarget(ctx, tx, in.WorkspaceID, in.TargetType, in.TargetID); err != nil {
			return err
		}
		// A reply must sit on a comment of the same target, so a valid UUID
		// from another thread cannot be used as a parent.
		if in.ParentID != nil {
			var exists bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM comment
				               WHERE id = $1 AND workspace_id = $2
				                 AND target_type = $3::comment_target AND target_id = $4)`,
				*in.ParentID, in.WorkspaceID, in.TargetType, in.TargetID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
		}

		row := tx.QueryRow(ctx, `
			WITH inserted AS (
			    INSERT INTO comment (workspace_id, target_type, target_id, parent_id,
			                         author_id, body)
			    VALUES ($1, $2::comment_target, $3, $4, $5, $6)
			    RETURNING *
			)
			SELECT `+commentCols+`
			FROM inserted c JOIN app_user u ON u.id = c.author_id`,
			in.WorkspaceID, in.TargetType, in.TargetID, in.ParentID, in.ActorID, in.Body)
		if err := scanCommentRow(row, &out); err != nil {
			return err
		}

		if err := RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: in.WorkspaceID, ActorID: in.ActorID,
			Verb: VerbCommented, TargetType: "comment", TargetID: out.ID,
			Metadata: map[string]any{
				"target_type": in.TargetType,
				"target_id":   in.TargetID.String(),
				"excerpt":     excerpt(in.Body),
			},
		}); err != nil {
			return err
		}

		// A mention of someone outside the workspace resolves to no row, so an
		// unknown handle never fails the comment.
		logins := ParseMentions(in.Body)
		if len(logins) == 0 {
			return nil
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO comment_mention (comment_id, user_id)
			SELECT $1, u.id
			FROM app_user u
			JOIN membership m ON m.user_id = u.id AND m.workspace_id = $2
			WHERE lower(u.github_login) = ANY($3::text[])
			ON CONFLICT DO NOTHING`, out.ID, in.WorkspaceID, logins)
		return err
	})
	return out, err
}

func excerpt(body string) string {
	runes := []rune(body)
	if len(runes) <= excerptLen {
		return body
	}
	return string(runes[:excerptLen])
}

// checkCommentTarget keeps a valid UUID from another workspace from being
// commented on.
func checkCommentTarget(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, targetType string, targetID uuid.UUID) error {
	var query string
	switch targetType {
	case "issue":
		query = `SELECT EXISTS (SELECT 1 FROM issue WHERE id = $1 AND workspace_id = $2)`
	case "milestone":
		query = `SELECT EXISTS (SELECT 1 FROM milestone WHERE id = $1 AND workspace_id = $2)`
	default:
		return ErrNotFound
	}
	var exists bool
	if err := tx.QueryRow(ctx, query, targetID, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

// ListComments returns the thread oldest first, with replies nested under the
// comment they answer. A deleted comment is omitted entirely.
func (s *Store) ListComments(ctx context.Context, workspaceID uuid.UUID, targetType string, targetID uuid.UUID) ([]Comment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+commentCols+`
		FROM comment c JOIN app_user u ON u.id = c.author_id
		WHERE c.workspace_id = $1 AND c.target_type = $2::comment_target
		  AND c.target_id = $3 AND c.deleted_at IS NULL
		ORDER BY c.created_at, c.id`, workspaceID, targetType, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var flat []Comment
	for rows.Next() {
		var c Comment
		if err := scanCommentRow(rows, &c); err != nil {
			return nil, err
		}
		flat = append(flat, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Nesting happens in Go because the thread is one level deep by
	// construction, so a recursive query would buy nothing.
	out := []Comment{}
	index := map[uuid.UUID]int{}
	for _, c := range flat {
		if c.ParentID == nil {
			index[c.ID] = len(out)
			out = append(out, c)
		}
	}
	for _, c := range flat {
		if c.ParentID == nil {
			continue
		}
		// A reply whose parent was deleted has nowhere to nest, so it is
		// promoted rather than dropped from the log.
		if i, ok := index[*c.ParentID]; ok {
			out[i].Replies = append(out[i].Replies, c)
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

func (s *Store) GetComment(ctx context.Context, workspaceID, id uuid.UUID) (Comment, error) {
	var c Comment
	err := scanCommentRow(s.pool.QueryRow(ctx, `
		SELECT `+commentCols+`
		FROM comment c JOIN app_user u ON u.id = c.author_id
		WHERE c.workspace_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`,
		workspaceID, id), &c)
	return c, err
}

// UpdateComment is author-only: an edit changes what someone is on record as
// having said, so not even an admin may do it for them.
func (s *Store) UpdateComment(ctx context.Context, workspaceID, id, actorID uuid.UUID, body string) (Comment, error) {
	var out Comment
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var authorID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT author_id FROM comment
			WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
			workspaceID, id).Scan(&authorID)
		if err != nil {
			return mapErr(err)
		}
		if authorID != actorID {
			return ErrForbidden
		}

		row := tx.QueryRow(ctx, `
			WITH updated AS (
			    UPDATE comment SET body = $3, edited_at = now()
			    WHERE workspace_id = $1 AND id = $2
			    RETURNING *
			)
			SELECT `+commentCols+`
			FROM updated c JOIN app_user u ON u.id = c.author_id`,
			workspaceID, id, body)
		return scanCommentRow(row, &out)
	})
	return out, err
}

// DeleteComment is a soft delete, so the audit trail keeps the row even after
// the thread stops showing it. An admin may remove someone else's comment.
func (s *Store) DeleteComment(ctx context.Context, workspaceID, id, actorID uuid.UUID, isAdmin bool) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var authorID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT author_id FROM comment
			WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
			workspaceID, id).Scan(&authorID)
		if err != nil {
			return mapErr(err)
		}
		if authorID != actorID && !isAdmin {
			return ErrForbidden
		}
		_, err = tx.Exec(ctx, `
			UPDATE comment SET deleted_at = now() WHERE workspace_id = $1 AND id = $2`,
			workspaceID, id)
		return err
	})
}
