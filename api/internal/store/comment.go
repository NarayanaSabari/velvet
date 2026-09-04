package store

import (
	"github.com/google/uuid"
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
