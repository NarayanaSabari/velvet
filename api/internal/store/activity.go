package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	VerbCommented          = "commented"
	VerbCreatedIssue       = "created_issue"
	VerbChangedStatus      = "changed_status"
	VerbAssigned           = "assigned"
	VerbAttachedPR         = "attached_pr"
	VerbCompletedMilestone = "completed_milestone"
	VerbClosedSprint       = "closed_sprint"
)

type ActivityInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Verb        string
	TargetType  string
	TargetID    uuid.UUID
	Metadata    map[string]any
}

type Activity struct {
	ID          int64          `json:"id"`
	WorkspaceID uuid.UUID      `json:"workspace_id"`
	Actor       *User          `json:"actor"`
	Verb        string         `json:"verb"`
	TargetType  string         `json:"target_type"`
	TargetID    uuid.UUID      `json:"target_id"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   string         `json:"created_at"`
}

// RecordActivity must be called with the same tx as the change it describes,
// so the feed can never disagree with the underlying data.
func RecordActivity(ctx context.Context, tx pgx.Tx, a ActivityInput) error {
	meta := a.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO activity (workspace_id, actor_id, verb, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		a.WorkspaceID, a.ActorID, a.Verb, a.TargetType, a.TargetID, meta)
	if err != nil {
		return fmt.Errorf("record activity %s: %w", a.Verb, err)
	}
	return nil
}

// NextIssueKey allocates the next per-workspace issue number. The UPDATE takes
// a row lock, so two concurrent creators serialise rather than collide.
func (s *Store) NextIssueKey(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (string, int64, error) {
	var prefix string
	var number int64
	err := tx.QueryRow(ctx, `
		UPDATE workspace SET issue_counter = issue_counter + 1
		WHERE id = $1
		RETURNING issue_prefix, issue_counter`, workspaceID).Scan(&prefix, &number)
	if err != nil {
		return "", 0, mapErr(err)
	}
	return fmt.Sprintf("%s-%d", prefix, number), number, nil
}
