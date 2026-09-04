package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Sprint struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Name        string    `json:"name"`
	StartsOn    string    `json:"starts_on"`
	EndsOn      string    `json:"ends_on"`
	State       string    `json:"state"`
	CreatedAt   string    `json:"created_at"`
	CompletedAt *string   `json:"completed_at"`
}

type CreateSprintInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Name        string
	StartsOn    string
	EndsOn      string
}

const sprintCols = `id, workspace_id, name,
	to_char(starts_on, 'YYYY-MM-DD'), to_char(ends_on, 'YYYY-MM-DD'),
	state::text, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
	to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')`

func scanSprint(row pgx.Row) (Sprint, error) {
	var s Sprint
	err := row.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.StartsOn, &s.EndsOn,
		&s.State, &s.CreatedAt, &s.CompletedAt)
	return s, mapErr(err)
}

func (s *Store) CreateSprint(ctx context.Context, in CreateSprintInput) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
			VALUES ($1, $2, $3::date, $4::date)
			RETURNING `+sprintCols,
			in.WorkspaceID, in.Name, in.StartsOn, in.EndsOn)
		var err error
		out, err = scanSprint(row)
		return err
	})
	return out, err
}

func (s *Store) ListSprints(ctx context.Context, workspaceID uuid.UUID) ([]Sprint, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+sprintCols+` FROM sprint WHERE workspace_id = $1 ORDER BY starts_on DESC`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Sprint{}
	for rows.Next() {
		sp, err := scanSprint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

func (s *Store) GetSprint(ctx context.Context, workspaceID, id uuid.UUID) (Sprint, error) {
	return scanSprint(s.pool.QueryRow(ctx,
		`SELECT `+sprintCols+` FROM sprint WHERE workspace_id = $1 AND id = $2`,
		workspaceID, id))
}

// ActivateSprint makes one sprint active, completing whichever sprint was
// active before. The schema allows only one active sprint per workspace, so
// this is done in a single transaction.
func (s *Store) ActivateSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND state = 'active' AND id <> $2`,
			workspaceID, id); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'active', completed_at = NULL
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		out, err = scanSprint(row)
		return err
	})
	return out, err
}

func (s *Store) CloseSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		if out, err = scanSprint(row); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbClosedSprint, TargetType: "sprint", TargetID: id,
			Metadata: map[string]any{"name": out.Name},
		})
	})
	return out, err
}
