package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

func scanLabel(row pgx.Row) (Label, error) {
	var l Label
	err := row.Scan(&l.ID, &l.WorkspaceID, &l.Name, &l.Color)
	return l, mapErr(err)
}

func (s *Store) CreateLabel(ctx context.Context, workspaceID uuid.UUID, name, color string) (Label, error) {
	return scanLabel(s.pool.QueryRow(ctx, `
		INSERT INTO label (workspace_id, name, color) VALUES ($1, $2, $3)
		RETURNING `+labelCols, workspaceID, name, color))
}

func (s *Store) ListLabels(ctx context.Context, workspaceID uuid.UUID) ([]Label, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+labelCols+` FROM label WHERE workspace_id = $1 ORDER BY name`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Label{}
	for rows.Next() {
		l, err := scanLabel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) DeleteLabel(ctx context.Context, workspaceID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM label WHERE workspace_id = $1 AND id = $2`, workspaceID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetIssueLabels replaces the whole set in one transaction, so a client never
// has to reason about which individual attachments it must add or remove.
func (s *Store) SetIssueLabels(ctx context.Context, workspaceID, issueID uuid.UUID, labelIDs []uuid.UUID) ([]Label, error) {
	var out []Label
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM issue WHERE id = $1 AND workspace_id = $2)`,
			issueID, workspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}

		// Every label must belong to this workspace, so a valid UUID from
		// another workspace cannot be attached.
		var owned int
		if err := tx.QueryRow(ctx, `
			SELECT count(DISTINCT id) FROM label
			WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
			workspaceID, labelIDs).Scan(&owned); err != nil {
			return err
		}
		if owned != len(distinctUUIDs(labelIDs)) {
			return ErrForeignReference
		}

		if _, err := tx.Exec(ctx,
			`DELETE FROM issue_label WHERE issue_id = $1`, issueID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO issue_label (issue_id, label_id)
			SELECT $1, DISTINCT_IDS.id FROM unnest($2::uuid[]) AS DISTINCT_IDS(id)
			ON CONFLICT DO NOTHING`, issueID, labelIDs); err != nil {
			return err
		}

		var err error
		out, err = labelsForIssue(ctx, tx, workspaceID, issueID)
		return err
	})
	return out, err
}

// querier is the part of a pool and a transaction that a read needs, so one
// query can serve both a standalone call and a step inside a transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func labelsForIssue(ctx context.Context, q querier, workspaceID, issueID uuid.UUID) ([]Label, error) {
	rows, err := q.Query(ctx, `
		SELECT l.id, l.workspace_id, l.name, l.color
		FROM label l JOIN issue_label il ON il.label_id = l.id
		WHERE l.workspace_id = $1 AND il.issue_id = $2
		ORDER BY l.name`, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Label{}
	for rows.Next() {
		l, err := scanLabel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func distinctUUIDs(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]bool, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
