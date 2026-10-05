package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Sprint struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	ProjectID   uuid.UUID `json:"project_id"`
	Name        string    `json:"name"`
	StartsOn    string    `json:"starts_on"`
	EndsOn      string    `json:"ends_on"`
	State       string    `json:"state"`
	CreatedAt   string    `json:"created_at"`
	CompletedAt *string   `json:"completed_at"`
}

type CreateSprintInput struct {
	WorkspaceID uuid.UUID
	ProjectID   uuid.UUID
	ActorID     uuid.UUID
	Name        string
	StartsOn    string
	EndsOn      string
}

// SprintFilter narrows a sprint list to one project. A zero ProjectID lists
// every project's sprints.
type SprintFilter struct {
	ProjectID uuid.UUID
}

const sprintCols = `id, workspace_id, project_id, name,
	to_char(starts_on, 'YYYY-MM-DD'), to_char(ends_on, 'YYYY-MM-DD'),
	state::text, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM')`

func scanSprint(row pgx.Row) (Sprint, error) {
	var s Sprint
	err := row.Scan(&s.ID, &s.WorkspaceID, &s.ProjectID, &s.Name, &s.StartsOn, &s.EndsOn,
		&s.State, &s.CreatedAt, &s.CompletedAt)
	return s, mapErr(err)
}

// CreateSprint starts a sprint for one project. The project must belong to
// the same organisation, so a valid id from elsewhere cannot be borrowed.
func (s *Store) CreateSprint(ctx context.Context, in CreateSprintInput) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, in.WorkspaceID, in.ActorID); err != nil {
			return err
		}
		if err := checkProjectInWorkspace(ctx, tx, in.WorkspaceID, in.ProjectID); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on)
			VALUES ($1, $2, $3, $4::date, $5::date)
			RETURNING `+sprintCols,
			in.WorkspaceID, in.ProjectID, in.Name, in.StartsOn, in.EndsOn)
		var err error
		if out, err = scanSprint(row); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: in.WorkspaceID, ActorID: in.ActorID,
			Verb: VerbCreatedSprint, TargetType: "sprint", TargetID: out.ID,
			Metadata: map[string]any{
				"name": out.Name, "starts_on": out.StartsOn, "ends_on": out.EndsOn,
				"project_id": out.ProjectID.String()},
		})
	})
	return out, err
}

func (s *Store) ListSprints(ctx context.Context, workspaceID uuid.UUID, f SprintFilter) ([]Sprint, error) {
	var project *uuid.UUID
	if f.ProjectID != uuid.Nil {
		project = &f.ProjectID
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+sprintCols+` FROM sprint
		 WHERE workspace_id = $1 AND ($2::uuid IS NULL OR project_id = $2)
		 ORDER BY starts_on DESC, name`,
		workspaceID, project)
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

// ActivateSprint makes one sprint active, completing whichever sprint of the
// same project was active before. Each project runs its own sprints, so
// another project's active sprint is left alone. The schema allows only one
// active sprint per project, so this is done in a single transaction.
func (s *Store) ActivateSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND state = 'active' AND id <> $2
			  AND project_id = (SELECT project_id FROM sprint WHERE workspace_id = $1 AND id = $2)`,
			workspaceID, id); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'active', completed_at = NULL
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		if out, err = scanSprint(row); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbActivatedSprint, TargetType: "sprint", TargetID: id,
			Metadata: map[string]any{"name": out.Name},
		})
	})
	return out, err
}

// CloseSprint completes a sprint, freezes its report, and carries unfinished
// work into the next one. All three happen in a single transaction, so the
// snapshot can never describe a state that the roll-forward has already
// changed.
func (s *Store) CloseSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		if out, err = scanSprint(row); err != nil {
			return err
		}
		// Capture before rolling forward: the snapshot must describe the
		// sprint as it was closed, not as it looks after the carry.
		if err := captureSnapshot(ctx, tx, workspaceID, id); err != nil {
			return err
		}
		if err := rollIncompleteIssuesForward(ctx, tx, workspaceID, id); err != nil {
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
