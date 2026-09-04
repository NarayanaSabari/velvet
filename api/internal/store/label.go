package store

import (
	"context"

	"github.com/google/uuid"
)

// Label is a workspace-scoped tag joined to issues through issue_label. The
// label store lands with the label endpoints; the type lives here so that an
// issue row can carry the labels attached to it.
type Label struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
}

const labelCols = `id, workspace_id, name, color`

func (s *Store) labelsForIssue(ctx context.Context, workspaceID, issueID uuid.UUID) ([]Label, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT l.id, l.workspace_id, l.name, l.color
		FROM label l JOIN issue_label il ON il.label_id = l.id
		WHERE l.workspace_id = $1 AND il.issue_id = $2
		ORDER BY l.name`, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Label
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.WorkspaceID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
