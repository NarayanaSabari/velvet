package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SprintSnapshot is a sprint's report frozen at the moment it closed.
//
// It is stored rather than computed because a report of last month that
// changes when somebody edits an old issue is not a report. Once written it
// is never updated.
type SprintSnapshot struct {
	SprintID            uuid.UUID      `json:"sprint_id"`
	WorkspaceID         uuid.UUID      `json:"workspace_id"`
	MilestonesPlanned   int            `json:"milestones_planned"`
	MilestonesCompleted int            `json:"milestones_completed"`
	IssueCounts         map[string]int `json:"issue_counts"`
	PersonTotals        map[string]int `json:"person_totals"`
	CapturedAt          string         `json:"captured_at"`
}

const snapshotCols = `sprint_id, workspace_id, milestones_planned, milestones_completed,
	issue_counts, person_totals,
	to_char(captured_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')`

func scanSnapshot(row pgx.Row) (SprintSnapshot, error) {
	var s SprintSnapshot
	err := row.Scan(&s.SprintID, &s.WorkspaceID, &s.MilestonesPlanned,
		&s.MilestonesCompleted, &s.IssueCounts, &s.PersonTotals, &s.CapturedAt)
	if err != nil {
		return s, mapErr(err)
	}
	if s.IssueCounts == nil {
		s.IssueCounts = map[string]int{}
	}
	if s.PersonTotals == nil {
		s.PersonTotals = map[string]int{}
	}
	return s, nil
}

// GetSnapshot reads a frozen sprint report. It is workspace-scoped like every
// other read, so a sprint ID from another workspace reads as missing.
func (s *Store) GetSnapshot(ctx context.Context, workspaceID, sprintID uuid.UUID) (SprintSnapshot, error) {
	return scanSnapshot(s.pool.QueryRow(ctx,
		`SELECT `+snapshotCols+` FROM sprint_snapshot
		 WHERE workspace_id = $1 AND sprint_id = $2`, workspaceID, sprintID))
}

// captureSnapshot freezes the sprint's numbers inside the closing transaction,
// so the snapshot describes exactly the state that was closed.
//
// It is written with ON CONFLICT DO NOTHING: closing a sprint twice must not
// overwrite the first close's numbers with a later, drifted set.
func captureSnapshot(ctx context.Context, tx pgx.Tx, workspaceID, sprintID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO sprint_snapshot (sprint_id, workspace_id, milestones_planned,
			milestones_completed, issue_counts, person_totals)
		SELECT $2, $1,
		    (SELECT count(*) FROM milestone
		     WHERE workspace_id = $1 AND sprint_id = $2 AND status <> 'cancelled'),
		    (SELECT count(*) FROM milestone
		     WHERE workspace_id = $1 AND sprint_id = $2 AND status = 'completed'),
		    COALESCE((
		        SELECT jsonb_object_agg(status, n) FROM (
		            SELECT i.status::text AS status, count(*) AS n
		            FROM issue i
		            JOIN milestone m ON m.id = i.milestone_id
		            WHERE i.workspace_id = $1 AND m.sprint_id = $2
		            GROUP BY i.status
		        ) counts
		    ), '{}'::jsonb),
		    COALESCE((
		        SELECT jsonb_object_agg(login, n) FROM (
		            SELECT COALESCE(u.github_login, 'system') AS login, count(*) AS n
		            FROM activity a
		            LEFT JOIN app_user u ON u.id = a.actor_id
		            WHERE a.workspace_id = $1
		              AND a.created_at >= (SELECT starts_on FROM sprint WHERE id = $2)
		              AND a.created_at < (SELECT ends_on FROM sprint WHERE id = $2) + interval '1 day'
		            GROUP BY COALESCE(u.github_login, 'system')
		        ) totals
		    ), '{}'::jsonb)
		ON CONFLICT (sprint_id) DO NOTHING`, workspaceID, sprintID)
	return err
}

// rollIncompleteIssuesForward moves unfinished work into the next upcoming
// sprint, matching milestones by name where one already exists there and
// creating it otherwise.
//
// It only ever changes milestone_id. Status is left exactly as it was: rolling
// work forward is an act of bookkeeping, and silently completing or cancelling
// somebody's issue because a month ended would be a lie in the record.
//
// When there is no upcoming sprint, the issues stay where they are rather than
// the close inventing a sprint nobody planned.
func rollIncompleteIssuesForward(ctx context.Context, tx pgx.Tx, workspaceID, sprintID uuid.UUID) error {
	var nextSprint uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM sprint
		WHERE workspace_id = $1 AND state = 'upcoming' AND id <> $2
		ORDER BY starts_on ASC LIMIT 1`, workspaceID, sprintID).Scan(&nextSprint)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	rows, err := tx.Query(ctx, `
		SELECT m.id, m.name, m.description, m.owner_id, m.position
		FROM milestone m
		WHERE m.workspace_id = $1 AND m.sprint_id = $2
		  AND EXISTS (
		      SELECT 1 FROM issue i
		      WHERE i.milestone_id = m.id
		        AND i.status NOT IN ('done', 'cancelled'))
		ORDER BY m.position`, workspaceID, sprintID)
	if err != nil {
		return err
	}

	type carry struct {
		id          uuid.UUID
		name        string
		description string
		ownerID     *uuid.UUID
	}
	var carried []carry
	for rows.Next() {
		var c carry
		var position string
		if err := rows.Scan(&c.id, &c.name, &c.description, &c.ownerID, &position); err != nil {
			rows.Close()
			return err
		}
		carried = append(carried, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, c := range carried {
		var target uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT id FROM milestone
			WHERE workspace_id = $1 AND sprint_id = $2 AND name = $3
			LIMIT 1`, workspaceID, nextSprint, c.name).Scan(&target)
		if errors.Is(err, pgx.ErrNoRows) {
			position, perr := nextMilestonePosition(ctx, tx, workspaceID, nextSprint)
			if perr != nil {
				return perr
			}
			err = tx.QueryRow(ctx, `
				INSERT INTO milestone (workspace_id, sprint_id, name, description,
					owner_id, position, status)
				VALUES ($1, $2, $3, $4, $5, $6, 'planned')
				RETURNING id`,
				workspaceID, nextSprint, c.name, c.description, c.ownerID, position).Scan(&target)
		}
		if err != nil {
			return err
		}

		if _, err := tx.Exec(ctx, `
			UPDATE issue SET milestone_id = $1, updated_at = now()
			WHERE workspace_id = $2 AND milestone_id = $3
			  AND status NOT IN ('done', 'cancelled')`,
			target, workspaceID, c.id); err != nil {
			return err
		}
	}
	return nil
}
