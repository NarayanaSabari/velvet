package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Workspace struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	IssuePrefix string    `json:"issue_prefix"`
}

const VerbRenamedOrganisation = "renamed_organisation"

func (s *Store) CreateWorkspace(ctx context.Context, actorID uuid.UUID, name, slug, prefix string) (Membership, error) {
	var m Membership
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO workspace(name,slug,issue_prefix) VALUES ($1,$2,$3) RETURNING id,name,slug,issue_prefix`, name, slug, prefix).Scan(&m.WorkspaceID, &m.Name, &m.Slug, &m.IssuePrefix); err != nil {
			return mapErr(err)
		}
		return mapErr(tx.QueryRow(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,'admin') RETURNING id,role::text`, m.WorkspaceID, actorID).Scan(&m.ID, &m.Role))
	})
	return m, err
}

// UpdateWorkspaceName locks the workspace and rechecks the actor's admin role
// before changing its name, so a demoted admin cannot win a race with the
// request that removed their access.
func (s *Store) UpdateWorkspaceName(ctx context.Context, workspaceID, actorID uuid.UUID, name string) (Workspace, error) {
	var out Workspace
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		var previousName string
		if err := tx.QueryRow(ctx, `SELECT name FROM workspace WHERE id=$1`, workspaceID).Scan(&previousName); err != nil {
			return mapErr(err)
		}
		if err := tx.QueryRow(ctx, `
			UPDATE workspace SET name=$1 WHERE id=$2
			RETURNING id,name,slug,issue_prefix`, name, workspaceID).
			Scan(&out.ID, &out.Name, &out.Slug, &out.IssuePrefix); err != nil {
			return mapErr(err)
		}
		if previousName == name {
			return nil
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID,
			ActorID:     actorID,
			Verb:        VerbRenamedOrganisation,
			TargetType:  "workspace",
			TargetID:    workspaceID,
			Metadata:    map[string]any{"from": previousName, "to": name},
		})
	})
	return out, err
}

func lockWorkspaceActorTx(ctx context.Context, tx pgx.Tx, workspaceID, actorID uuid.UUID) (string, error) {
	if err := lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
		return "", err
	}
	var role string
	err := tx.QueryRow(ctx, `SELECT role::text FROM membership WHERE workspace_id=$1 AND user_id=$2`, workspaceID, actorID).Scan(&role)
	return role, mapErr(err)
}

// LockWorkspaceAdminTx serializes access changes and rechecks the actor after
// the lock. Integration binding must use the same workspace-first order.
func LockWorkspaceAdminTx(ctx context.Context, tx pgx.Tx, workspaceID, actorID uuid.UUID) error {
	role, err := lockWorkspaceActorTx(ctx, tx, workspaceID, actorID)
	if err != nil {
		return err
	}
	if role != "admin" {
		return ErrForbidden
	}
	return nil
}

func retainAdminTx(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, previousRole string) error {
	if previousRole != "admin" {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM membership WHERE workspace_id=$1 AND role='admin'`, workspaceID).Scan(&count); err != nil {
		return err
	}
	if count <= 1 {
		return ErrLastAdmin
	}
	return nil
}

func (s *Store) DeleteWorkspace(ctx context.Context, workspaceID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, workspaceID)
		return err
	})
}

func (s *Store) LeaveWorkspace(ctx context.Context, workspaceID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		role, err := lockWorkspaceActorTx(ctx, tx, workspaceID, actorID)
		if err != nil {
			return err
		}
		if err := retainAdminTx(ctx, tx, workspaceID, role); err != nil {
			return err
		}
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2 RETURNING id`, workspaceID, actorID).Scan(&id); err != nil {
			return mapErr(err)
		}
		return RecordActivity(ctx, tx, ActivityInput{WorkspaceID: workspaceID, ActorID: actorID, Verb: "left_organisation", TargetType: "membership", TargetID: id})
	})
}

func (s *Store) RemoveWorkspaceMembership(ctx context.Context, workspaceID, membershipID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		var role string
		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT role::text,user_id FROM membership WHERE workspace_id=$1 AND id=$2`, workspaceID, membershipID).Scan(&role, &userID); err != nil {
			return mapErr(err)
		}
		if err := retainAdminTx(ctx, tx, workspaceID, role); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM membership WHERE workspace_id=$1 AND id=$2`, workspaceID, membershipID); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{WorkspaceID: workspaceID, ActorID: actorID, Verb: "removed_member", TargetType: "membership", TargetID: membershipID, Metadata: map[string]any{"user_id": userID}})
	})
}
