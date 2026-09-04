package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/fracdex"
)

type Issue struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	Key         string     `json:"key"`
	Number      int64      `json:"number"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      string     `json:"status"`
	Priority    int        `json:"priority"`
	AssigneeID  *uuid.UUID `json:"assignee_id"`
	MilestoneID *uuid.UUID `json:"milestone_id"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Position    string     `json:"position"`
	CreatedBy   *uuid.UUID `json:"created_by"`
	CreatedAt   string     `json:"created_at"`
	UpdatedAt   string     `json:"updated_at"`
	Labels      []Label    `json:"labels,omitempty"`
	Children    []Issue    `json:"children,omitempty"`
}

type CreateIssueInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Title       string
	Description string
	Status      string
	Priority    int
	AssigneeID  *uuid.UUID
	MilestoneID *uuid.UUID
	ParentID    *uuid.UUID
}

// IssuePatch leaves a nil field unchanged. The reference fields are double
// pointers so that clearing one is distinguishable from not mentioning it.
type IssuePatch struct {
	Title       *string
	Description *string
	Status      *string
	Priority    *int
	AssigneeID  **uuid.UUID
	MilestoneID **uuid.UUID
	ParentID    **uuid.UUID
	AfterID     *uuid.UUID
	BeforeID    *uuid.UUID
}

// IssueFilter narrows a list. An empty filter lists the whole workspace.
type IssueFilter struct {
	MilestoneID *uuid.UUID
	SprintID    *uuid.UUID
	AssigneeID  *uuid.UUID
	Statuses    []string
	Cursor      string
	Limit       int
}

const (
	defaultIssueLimit = 50
	maxIssueLimit     = 200
)

func ValidIssueStatus(s string) bool {
	switch s {
	case "backlog", "todo", "in_progress", "in_review", "done", "cancelled":
		return true
	}
	return false
}

const issueCols = `id, workspace_id, key, number, title, description, status::text,
	priority, assignee_id, milestone_id, parent_id, position, created_by,
	to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
	to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')`

func scanIssue(row pgx.Row) (Issue, error) {
	var i Issue
	err := row.Scan(&i.ID, &i.WorkspaceID, &i.Key, &i.Number, &i.Title, &i.Description,
		&i.Status, &i.Priority, &i.AssigneeID, &i.MilestoneID, &i.ParentID,
		&i.Position, &i.CreatedBy, &i.CreatedAt, &i.UpdatedAt)
	return i, mapIssueErr(err)
}

// mapIssueErr translates the depth-guard trigger, which reports illegal
// nesting as a plain Postgres exception, into a sentinel the handlers can turn
// into a 400 rather than a 500.
func mapIssueErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && strings.Contains(pgErr.Message, "one level") {
		return ErrInvalidNesting
	}
	return mapErr(err)
}

// nextIssuePosition appends to the end of the target milestone's list, or to
// the unfiled list when the issue belongs to no milestone.
func nextIssuePosition(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, milestoneID *uuid.UUID) (string, error) {
	var last string
	err := tx.QueryRow(ctx, `
		SELECT position FROM issue
		WHERE workspace_id = $1 AND milestone_id IS NOT DISTINCT FROM $2
		ORDER BY position DESC LIMIT 1`, workspaceID, milestoneID).Scan(&last)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return fracdex.First(), nil
	case err != nil:
		return "", err
	default:
		return fracdex.Between(last, "")
	}
}

func (s *Store) CreateIssue(ctx context.Context, in CreateIssueInput) (Issue, error) {
	var out Issue
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := checkIssueReferences(ctx, tx, in.WorkspaceID, in.MilestoneID, in.ParentID); err != nil {
			return err
		}

		key, number, err := s.NextIssueKey(ctx, tx, in.WorkspaceID)
		if err != nil {
			return err
		}
		position, err := nextIssuePosition(ctx, tx, in.WorkspaceID, in.MilestoneID)
		if err != nil {
			return err
		}

		status := in.Status
		if status == "" {
			status = "backlog"
		}

		out, err = scanIssue(tx.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, key, number, title, description, status,
				priority, assignee_id, milestone_id, parent_id, position, created_by)
			VALUES ($1, $2, $3, $4, $5, $6::issue_status, $7, $8, $9, $10, $11, $12)
			RETURNING `+issueCols,
			in.WorkspaceID, key, number, in.Title, in.Description, status,
			in.Priority, in.AssigneeID, in.MilestoneID, in.ParentID, position, in.ActorID))
		if err != nil {
			return err
		}

		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: in.WorkspaceID, ActorID: in.ActorID,
			Verb: VerbCreatedIssue, TargetType: "issue", TargetID: out.ID,
			Metadata: map[string]any{"key": out.Key, "title": out.Title},
		})
	})
	return out, err
}

// checkIssueReferences keeps a valid UUID from another workspace from being
// used as a milestone or a parent.
func checkIssueReferences(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, milestoneID, parentID *uuid.UUID) error {
	if milestoneID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM milestone WHERE id = $1 AND workspace_id = $2)`,
			*milestoneID, workspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	if parentID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM issue WHERE id = $1 AND workspace_id = $2)`,
			*parentID, workspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}

// ListIssues pages on (position, id), which is stable because position is
// unique in practice and id breaks any tie.
func (s *Store) ListIssues(ctx context.Context, workspaceID uuid.UUID, f IssueFilter) ([]Issue, string, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = defaultIssueLimit
	}
	if limit > maxIssueLimit {
		limit = maxIssueLimit
	}

	cursorPosition, cursorID, err := decodeIssueCursor(f.Cursor)
	if err != nil {
		return nil, "", err
	}

	var statuses []string
	if len(f.Statuses) > 0 {
		statuses = f.Statuses
	}

	rows, err := s.pool.Query(ctx, `
		SELECT `+issueCols+`
		FROM issue i
		WHERE i.workspace_id = $1
		  AND ($2::uuid IS NULL OR i.milestone_id = $2)
		  AND ($3::uuid IS NULL OR i.milestone_id IN (
		        SELECT m.id FROM milestone m
		        WHERE m.workspace_id = $1 AND m.sprint_id = $3))
		  AND ($4::uuid IS NULL OR i.assignee_id = $4)
		  AND ($5::text[] IS NULL OR i.status::text = ANY($5))
		  AND ($6::text IS NULL OR (i.position, i.id) > ($6, $7::uuid))
		ORDER BY i.position, i.id
		LIMIT $8`,
		workspaceID, f.MilestoneID, f.SprintID, f.AssigneeID, statuses,
		cursorPosition, cursorID, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	out := []Issue{}
	for rows.Next() {
		issue, err := scanIssue(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, issue)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// A short page is the last page, so it carries no cursor and the client
	// stops rather than making one more empty round trip.
	next := ""
	if len(out) == limit {
		last := out[len(out)-1]
		next = encodeIssueCursor(last.Position, last.ID)
	}
	return out, next, nil
}

func encodeIssueCursor(position string, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(position + "|" + id.String()))
}

func decodeIssueCursor(cursor string) (*string, *uuid.UUID, error) {
	if cursor == "" {
		return nil, nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: cursor is not valid", ErrInvalidCursor)
	}
	position, rawID, found := strings.Cut(string(raw), "|")
	if !found {
		return nil, nil, fmt.Errorf("%w: cursor is not valid", ErrInvalidCursor)
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: cursor is not valid", ErrInvalidCursor)
	}
	return &position, &id, nil
}

// GetIssueByKey loads the issue with its labels and its direct children, which
// is everything the issue page needs about the issue itself.
func (s *Store) GetIssueByKey(ctx context.Context, workspaceID uuid.UUID, key string) (Issue, error) {
	issue, err := scanIssue(s.pool.QueryRow(ctx,
		`SELECT `+issueCols+` FROM issue WHERE workspace_id = $1 AND key = $2`,
		workspaceID, key))
	if err != nil {
		return Issue{}, err
	}

	if issue.Labels, err = s.labelsForIssue(ctx, workspaceID, issue.ID); err != nil {
		return Issue{}, err
	}

	rows, err := s.pool.Query(ctx,
		`SELECT `+issueCols+`
		 FROM issue WHERE workspace_id = $1 AND parent_id = $2 ORDER BY position, id`,
		workspaceID, issue.ID)
	if err != nil {
		return Issue{}, err
	}
	defer rows.Close()

	for rows.Next() {
		child, err := scanIssue(rows)
		if err != nil {
			return Issue{}, err
		}
		issue.Children = append(issue.Children, child)
	}
	return issue, rows.Err()
}

func (s *Store) UpdateIssue(ctx context.Context, workspaceID, id, actorID uuid.UUID, patch IssuePatch) (Issue, error) {
	var out Issue
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		before, err := scanIssue(tx.QueryRow(ctx,
			`SELECT `+issueCols+`
			 FROM issue WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
			workspaceID, id))
		if err != nil {
			return err
		}

		title := before.Title
		if patch.Title != nil {
			title = *patch.Title
		}
		description := before.Description
		if patch.Description != nil {
			description = *patch.Description
		}
		status := before.Status
		if patch.Status != nil {
			status = *patch.Status
		}
		priority := before.Priority
		if patch.Priority != nil {
			priority = *patch.Priority
		}
		assigneeID := before.AssigneeID
		if patch.AssigneeID != nil {
			assigneeID = *patch.AssigneeID
		}
		milestoneID := before.MilestoneID
		if patch.MilestoneID != nil {
			milestoneID = *patch.MilestoneID
		}
		parentID := before.ParentID
		if patch.ParentID != nil {
			parentID = *patch.ParentID
		}
		if err := checkIssueReferences(ctx, tx, workspaceID, milestoneID, parentID); err != nil {
			return err
		}

		position := before.Position
		if patch.AfterID != nil || patch.BeforeID != nil {
			position, err = repositionIssue(ctx, tx, workspaceID, milestoneID,
				patch.AfterID, patch.BeforeID)
			if err != nil {
				return err
			}
		}

		out, err = scanIssue(tx.QueryRow(ctx, `
			UPDATE issue
			SET title = $3, description = $4, status = $5::issue_status, priority = $6,
			    assignee_id = $7, milestone_id = $8, parent_id = $9, position = $10,
			    updated_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+issueCols,
			workspaceID, id, title, description, status, priority,
			assigneeID, milestoneID, parentID, position))
		if err != nil {
			return err
		}

		// One activity row per real change: re-sending an unchanged value must
		// not fill the feed with no-ops.
		if patch.Status != nil && *patch.Status != before.Status {
			if err := RecordActivity(ctx, tx, ActivityInput{
				WorkspaceID: workspaceID, ActorID: actorID,
				Verb: VerbChangedStatus, TargetType: "issue", TargetID: id,
				Metadata: map[string]any{
					"key": before.Key, "from": before.Status, "to": *patch.Status},
			}); err != nil {
				return err
			}
		}
		if patch.AssigneeID != nil && !sameUUIDPtr(before.AssigneeID, *patch.AssigneeID) {
			metadata := map[string]any{"key": before.Key, "assignee_id": nil}
			if assigneeID != nil {
				metadata["assignee_id"] = assigneeID.String()
			}
			if err := RecordActivity(ctx, tx, ActivityInput{
				WorkspaceID: workspaceID, ActorID: actorID,
				Verb: VerbAssigned, TargetType: "issue", TargetID: id,
				Metadata: metadata,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// repositionIssue resolves after/before neighbours into a fractional index.
// Both neighbours must sit in the same list, so a reorder cannot smuggle an
// issue into another milestone's ordering.
func repositionIssue(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, milestoneID, afterID, beforeID *uuid.UUID) (string, error) {
	neighbour := func(id *uuid.UUID) (string, error) {
		if id == nil {
			return "", nil
		}
		var pos string
		err := tx.QueryRow(ctx, `
			SELECT position FROM issue
			WHERE workspace_id = $1 AND milestone_id IS NOT DISTINCT FROM $2 AND id = $3`,
			workspaceID, milestoneID, *id).Scan(&pos)
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

func sameUUIDPtr(a, b *uuid.UUID) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
