package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/fracdex"
)

type Milestone struct {
	ID          uuid.UUID      `json:"id"`
	WorkspaceID uuid.UUID      `json:"workspace_id"`
	SprintID    uuid.UUID      `json:"sprint_id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	OwnerID     *uuid.UUID     `json:"owner_id"`
	TargetDate  *string        `json:"target_date"`
	Status      string         `json:"status"`
	Position    string         `json:"position"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
	IssueCounts map[string]int `json:"issue_counts,omitempty"`
	LastComment *Comment       `json:"last_comment,omitempty"`
}

type CreateMilestoneInput struct {
	WorkspaceID uuid.UUID
	SprintID    uuid.UUID
	ActorID     uuid.UUID
	Name        string
	Description string
	OwnerID     *uuid.UUID
	TargetDate  *string
}

// MilestonePatch leaves a nil field unchanged. TargetDate and OwnerID are
// double pointers so clearing a value is distinguishable from omitting it.
type MilestonePatch struct {
	Name        *string
	Description *string
	Status      *string
	TargetDate  **string
	OwnerID     **uuid.UUID
	AfterID     *uuid.UUID
	BeforeID    *uuid.UUID
}

func ValidMilestoneStatus(s string) bool {
	switch s {
	case "planned", "in_progress", "completed", "cancelled":
		return true
	}
	return false
}

const milestoneCols = `id, workspace_id, sprint_id, name, description, owner_id,
	to_char(target_date, 'YYYY-MM-DD'), status::text, position,
	to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM')`

func scanMilestone(row pgx.Row) (Milestone, error) {
	var m Milestone
	err := row.Scan(&m.ID, &m.WorkspaceID, &m.SprintID, &m.Name, &m.Description,
		&m.OwnerID, &m.TargetDate, &m.Status, &m.Position, &m.CreatedAt, &m.UpdatedAt)
	return m, mapErr(err)
}

// nextMilestonePosition appends to the end of the sprint's list, so a create
// never has to renumber the rows already there.
func nextMilestonePosition(ctx context.Context, tx pgx.Tx, workspaceID, sprintID uuid.UUID) (string, error) {
	var last string
	err := tx.QueryRow(ctx, `
		SELECT position FROM milestone
		WHERE workspace_id = $1 AND sprint_id = $2
		ORDER BY position DESC LIMIT 1`, workspaceID, sprintID).Scan(&last)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return fracdex.First(), nil
	case err != nil:
		return "", err
	default:
		return fracdex.Between(last, "")
	}
}

func (s *Store) CreateMilestone(ctx context.Context, in CreateMilestoneInput) (Milestone, error) {
	var out Milestone
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		// The sprint must belong to the caller's workspace, so a valid UUID
		// from another workspace cannot be used as a parent.
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM sprint WHERE id = $1 AND workspace_id = $2)`,
			in.SprintID, in.WorkspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if in.OwnerID != nil {
			if err := checkWorkspaceMember(ctx, tx, in.WorkspaceID, *in.OwnerID); err != nil {
				return err
			}
		}

		position, err := nextMilestonePosition(ctx, tx, in.WorkspaceID, in.SprintID)
		if err != nil {
			return err
		}

		row := tx.QueryRow(ctx, `
			INSERT INTO milestone (workspace_id, sprint_id, name, description,
				owner_id, target_date, position)
			VALUES ($1, $2, $3, $4, $5, $6::date, $7)
			RETURNING `+milestoneCols,
			in.WorkspaceID, in.SprintID, in.Name, in.Description,
			in.OwnerID, in.TargetDate, position)
		out, err = scanMilestone(row)
		return err
	})
	return out, err
}

// ListMilestonesForSprint returns issue counts and the latest comment in one
// round trip, because the sprint view needs both for every row.
func (s *Store) ListMilestonesForSprint(ctx context.Context, workspaceID, sprintID uuid.UUID) ([]Milestone, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.workspace_id, m.sprint_id, m.name, m.description, m.owner_id,
		       to_char(m.target_date, 'YYYY-MM-DD'), m.status::text, m.position,
		       to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       to_char(m.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       COALESCE(counts.by_status, '{}'::jsonb),
		       lc.id, lc.body,
		       to_char(lc.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       lc.author_id, lc.author_email, lc.github_id, lc.github_login, lc.author_name, lc.avatar_url
		FROM milestone m
		LEFT JOIN LATERAL (
		    SELECT jsonb_object_agg(status, n) AS by_status
		    FROM (SELECT status::text AS status, count(*) AS n
		          FROM issue WHERE milestone_id = m.id GROUP BY status) s
		) counts ON true
		LEFT JOIN LATERAL (
		    SELECT c.id, c.body, c.created_at, c.author_id, u.email AS author_email,
		           u.github_id, u.github_login, u.name AS author_name, u.avatar_url
		    FROM comment c JOIN app_user u ON u.id = c.author_id
		    WHERE c.target_type = 'milestone' AND c.target_id = m.id AND c.deleted_at IS NULL
		    ORDER BY c.created_at DESC LIMIT 1
		) lc ON true
		WHERE m.workspace_id = $1 AND m.sprint_id = $2
		ORDER BY m.position`, workspaceID, sprintID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Milestone{}
	for rows.Next() {
		var m Milestone
		var counts map[string]int
		var commentID *uuid.UUID
		var body, createdAt *string
		var authorID *uuid.UUID
		var githubID *int64
		var authorEmail, githubLogin, authorName, avatarURL *string
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.SprintID, &m.Name, &m.Description,
			&m.OwnerID, &m.TargetDate, &m.Status, &m.Position, &m.CreatedAt, &m.UpdatedAt,
			&counts, &commentID, &body, &createdAt,
			&authorID, &authorEmail, &githubID, &githubLogin, &authorName, &avatarURL); err != nil {
			return nil, err
		}
		if counts == nil {
			counts = map[string]int{}
		}
		m.IssueCounts = counts
		if commentID != nil {
			c := Comment{
				ID: *commentID, WorkspaceID: workspaceID,
				TargetType: "milestone", TargetID: m.ID,
			}
			if body != nil {
				c.Body = *body
			}
			if createdAt != nil {
				c.CreatedAt = *createdAt
			}
			if authorID != nil {
				c.Author = User{ID: *authorID, GitHubID: githubID, GitHubLogin: githubLogin}
				if authorEmail != nil {
					c.Author.Email = *authorEmail
				}
				if authorName != nil {
					c.Author.Name = *authorName
				}
				if avatarURL != nil {
					c.Author.AvatarURL = *avatarURL
				}
			}
			m.LastComment = &c
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListMilestones returns the workspace-wide filing choices used when moving
// an issue. Sprint-specific boards use ListMilestonesForSprint for rollups.
func (s *Store) ListMilestones(ctx context.Context, workspaceID uuid.UUID) ([]Milestone, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+milestoneCols+`
		FROM milestone
		WHERE workspace_id = $1
		ORDER BY created_at DESC, position`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Milestone{}
	for rows.Next() {
		milestone, err := scanMilestone(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, milestone)
	}
	return out, rows.Err()
}

func (s *Store) GetMilestone(ctx context.Context, workspaceID, id uuid.UUID) (Milestone, error) {
	return scanMilestone(s.pool.QueryRow(ctx,
		`SELECT `+milestoneCols+` FROM milestone WHERE workspace_id = $1 AND id = $2`,
		workspaceID, id))
}

func (s *Store) UpdateMilestone(ctx context.Context, workspaceID, id, actorID uuid.UUID, patch MilestonePatch) (Milestone, error) {
	var out Milestone
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		before, err := scanMilestone(tx.QueryRow(ctx,
			`SELECT `+milestoneCols+`
			 FROM milestone WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
			workspaceID, id))
		if err != nil {
			return err
		}

		position := before.Position
		if patch.AfterID != nil || patch.BeforeID != nil {
			position, err = s.reposition(ctx, tx, workspaceID, before.SprintID,
				patch.AfterID, patch.BeforeID)
			if err != nil {
				return err
			}
		}

		name := before.Name
		if patch.Name != nil {
			name = *patch.Name
		}
		description := before.Description
		if patch.Description != nil {
			description = *patch.Description
		}
		status := before.Status
		if patch.Status != nil {
			status = *patch.Status
		}
		targetDate := before.TargetDate
		if patch.TargetDate != nil {
			targetDate = *patch.TargetDate
		}
		ownerID := before.OwnerID
		if patch.OwnerID != nil {
			ownerID = *patch.OwnerID
		}
		if ownerID != nil {
			if err := checkWorkspaceMember(ctx, tx, workspaceID, *ownerID); err != nil {
				return err
			}
		}

		out, err = scanMilestone(tx.QueryRow(ctx, `
			UPDATE milestone
			SET name = $3, description = $4, status = $5::milestone_status,
			    target_date = $6::date, owner_id = $7, position = $8, updated_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+milestoneCols,
			workspaceID, id, name, description, status, targetDate, ownerID, position))
		if err != nil {
			return err
		}

		// Record completed_milestone activity only on the transition into
		// 'completed', so re-saving a completed milestone does not spam the feed.
		if patch.Status != nil && *patch.Status == "completed" && before.Status != "completed" {
			if err := RecordActivity(ctx, tx, ActivityInput{
				WorkspaceID: workspaceID, ActorID: actorID,
				Verb: VerbCompletedMilestone, TargetType: "milestone", TargetID: id,
				Metadata: map[string]any{"name": out.Name},
			}); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// reposition resolves after/before neighbours into a fractional index. Both
// neighbours must belong to the same sprint, so a reorder cannot smuggle a
// milestone into another sprint's list.
func (s *Store) reposition(ctx context.Context, tx pgx.Tx, workspaceID, sprintID uuid.UUID, afterID, beforeID *uuid.UUID) (string, error) {
	neighbour := func(id *uuid.UUID) (string, error) {
		if id == nil {
			return "", nil
		}
		var pos string
		err := tx.QueryRow(ctx, `
			SELECT position FROM milestone
			WHERE workspace_id = $1 AND sprint_id = $2 AND id = $3`,
			workspaceID, sprintID, *id).Scan(&pos)
		return pos, mapErr(err)
	}
	lo, err := neighbour(afterID)
	if err != nil {
		return "", err
	}
	hi, err := neighbour(beforeID)
	if err != nil {
		return "", err
	}
	return fracdex.Between(lo, hi)
}
