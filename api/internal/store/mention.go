package store

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// A mention is an @login at a word boundary. The leading boundary class keeps
// an email address like me@example.com from parsing as a mention, and inline
// code spans are stripped first so a documented handle is not a notification.
var (
	codeSpanRe = regexp.MustCompile("`[^`]*`")
	mentionRe  = regexp.MustCompile(`(^|[^A-Za-z0-9_./-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))`)
)

func ParseMentions(body string) []string {
	clean := codeSpanRe.ReplaceAllString(body, " ")

	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(clean, -1) {
		login := strings.ToLower(m[2])
		if seen[login] {
			continue
		}
		seen[login] = true
		out = append(out, login)
	}
	return out
}

// Mention is a comment that named the caller, with the read state that decides
// whether the inbox shows it as new.
type Mention struct {
	Comment     Comment `json:"comment"`
	ReadAt      *string `json:"read_at"`
	TargetLabel string  `json:"target_label"`
}

// ListMentions returns the comments that named this user, newest first. A
// deleted comment is skipped: retracting it retracts the notification too.
func (s *Store) ListMentions(ctx context.Context, workspaceID, userID uuid.UUID, unreadOnly bool) ([]Mention, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+commentCols+`,
		       to_char(cm.read_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       COALESCE(i.key, m.name, p.key, '')
		FROM comment_mention cm
		JOIN comment c ON c.id = cm.comment_id
		JOIN app_user u ON u.id = c.author_id
		LEFT JOIN issue i ON c.target_type = 'issue' AND i.id = c.target_id
		  AND i.workspace_id = c.workspace_id
		LEFT JOIN milestone m ON c.target_type = 'milestone' AND m.id = c.target_id
		  AND m.workspace_id = c.workspace_id
		LEFT JOIN project p ON c.target_type = 'project' AND p.id = c.target_id
		  AND p.workspace_id = c.workspace_id
		WHERE cm.user_id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL
		  AND (i.id IS NOT NULL OR m.id IS NOT NULL OR p.id IS NOT NULL)
		  AND (NOT $3::boolean OR cm.read_at IS NULL)
		ORDER BY c.created_at DESC`, userID, workspaceID, unreadOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Mention{}
	for rows.Next() {
		var m Mention
		if err := scanCommentRow(rows, &m.Comment, &m.ReadAt, &m.TargetLabel); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UnreadMentionCount is what the dashboard badge shows.
func (s *Store) UnreadMentionCount(ctx context.Context, workspaceID, userID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM comment_mention cm
		JOIN comment c ON c.id = cm.comment_id
		LEFT JOIN issue i ON c.target_type = 'issue' AND i.id = c.target_id
		  AND i.workspace_id = c.workspace_id
		LEFT JOIN milestone m ON c.target_type = 'milestone' AND m.id = c.target_id
		  AND m.workspace_id = c.workspace_id
		LEFT JOIN project p ON c.target_type = 'project' AND p.id = c.target_id
		  AND p.workspace_id = c.workspace_id
		WHERE cm.user_id = $1 AND c.workspace_id = $2
		  AND c.deleted_at IS NULL AND cm.read_at IS NULL
		  AND (i.id IS NOT NULL OR m.id IS NOT NULL OR p.id IS NOT NULL)`,
		userID, workspaceID).Scan(&n)
	return n, err
}

// MarkMentionsRead marks the named comments read, or every mention in the
// workspace when the list is empty.
func (s *Store) MarkMentionsRead(ctx context.Context, workspaceID, userID uuid.UUID, commentIDs []uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE comment_mention cm SET read_at = now()
		FROM comment c
		WHERE c.id = cm.comment_id AND cm.user_id = $1 AND c.workspace_id = $2
		  AND cm.read_at IS NULL
		  AND ($3::uuid[] IS NULL OR cm.comment_id = ANY($3))`,
		userID, workspaceID, nullableUUIDs(commentIDs))
	return err
}

// nullableUUIDs turns an empty list into a SQL NULL, which the queries read as
// "every row" rather than "no rows".
func nullableUUIDs(ids []uuid.UUID) []uuid.UUID {
	if len(ids) == 0 {
		return nil
	}
	return ids
}
