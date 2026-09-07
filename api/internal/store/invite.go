package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Invite is safe for API responses. The secret is only returned on creation.
type Invite struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	ExpiresAt   time.Time `json:"expires_at"`
}

const inviteCols = `id, workspace_id, email, role::text, expires_at`
const liveInvite = `accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()`

func scanInvite(row scanner) (Invite, error) {
	var i Invite
	err := row.Scan(&i.ID, &i.WorkspaceID, &i.Email, &i.Role, &i.ExpiresAt)
	return i, mapErr(err)
}

func (s *Store) ListMyInvites(ctx context.Context, userID uuid.UUID) ([]Invite, error) {
	return s.listInvites(ctx, `SELECT `+inviteCols+` FROM invite WHERE lower(btrim(email))=(SELECT lower(btrim(email)) FROM app_user WHERE id=$1) AND `+liveInvite+` ORDER BY created_at,id`, userID)
}

func (s *Store) ListWorkspaceInvites(ctx context.Context, workspaceID uuid.UUID) ([]Invite, error) {
	return s.listInvites(ctx, `SELECT `+inviteCols+` FROM invite WHERE workspace_id=$1 AND `+liveInvite+` ORDER BY created_at,id`, workspaceID)
}

func (s *Store) listInvites(ctx context.Context, query string, id uuid.UUID) ([]Invite, error) {
	rows, err := s.pool.Query(ctx, query, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		i, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) PreviewInviteToken(ctx context.Context, token string) (Invite, error) {
	return scanInvite(s.pool.QueryRow(ctx, `SELECT `+inviteCols+` FROM invite WHERE token_hash=$1 AND `+liveInvite, HashToken(token)))
}

func lockWorkspaceTx(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) error {
	var id uuid.UUID
	return mapErr(tx.QueryRow(ctx, `SELECT id FROM workspace WHERE id=$1 FOR UPDATE`, workspaceID).Scan(&id))
}

// LockInviteWorkspaceTx acquires the first lock in an invite transaction.
// Login confirmation calls this before locking its login token or user, then
// calls AcceptInviteTx after validating the token and establishing the user.
// The invite workspace is immutable. Acceptance rechecks the current invite.
func LockInviteWorkspaceTx(ctx context.Context, tx pgx.Tx, inviteID uuid.UUID) error {
	var workspaceID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM invite WHERE id=$1`, inviteID).Scan(&workspaceID); err != nil {
		return mapErr(err)
	}
	return lockWorkspaceTx(ctx, tx, workspaceID)
}

func insertInviteTx(ctx context.Context, tx pgx.Tx, workspaceID, actorID uuid.UUID, email, role string) (Invite, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return Invite{}, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	i, err := scanInvite(tx.QueryRow(ctx, `INSERT INTO invite(workspace_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,$2,$3::membership_role,$4,$5,now()+interval '7 days') RETURNING `+inviteCols, workspaceID, email, role, HashToken(token), actorID))
	if err != nil {
		return Invite{}, "", err
	}
	err = RecordActivity(ctx, tx, ActivityInput{WorkspaceID: workspaceID, ActorID: actorID, Verb: VerbInvitedMember, TargetType: "invite", TargetID: i.ID, Metadata: map[string]any{"email": email, "role": role}})
	return i, token, err
}

func (s *Store) CreateInvite(ctx context.Context, workspaceID, actorID uuid.UUID, email, role string) (Invite, string, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return Invite{}, "", err
	}
	var i Invite
	var token string
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
			return err
		}
		var err error
		i, token, err = insertInviteTx(ctx, tx, workspaceID, actorID, email, role)
		return err
	})
	if err != nil {
		return Invite{}, "", err
	}
	return i, token, nil
}

// ReplaceInvite preserves the old row for audit and invalidates its login
// links. The replacement gets a new id, which callers must return to the UI.
func (s *Store) ReplaceInvite(ctx context.Context, workspaceID, inviteID, actorID uuid.UUID, role string) (Invite, string, error) {
	var i Invite
	var token string
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
			return err
		}
		var email string
		if err := tx.QueryRow(ctx, `SELECT email FROM invite WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, inviteID, workspaceID).Scan(&email); err != nil {
			return mapErr(err)
		}
		if err := revokeInviteTx(ctx, tx, workspaceID, inviteID, actorID); err != nil {
			return err
		}
		var err error
		i, token, err = insertInviteTx(ctx, tx, workspaceID, actorID, email, role)
		return err
	})
	if err != nil {
		return Invite{}, "", err
	}
	return i, token, nil
}

func revokeInviteTx(ctx context.Context, tx pgx.Tx, workspaceID, inviteID, actorID uuid.UUID) error {
	tag, err := tx.Exec(ctx, `UPDATE invite SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, inviteID, workspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE login_token SET consumed_at=COALESCE(consumed_at,now()) WHERE invite_id=$1`, inviteID); err != nil {
		return err
	}
	return RecordActivity(ctx, tx, ActivityInput{WorkspaceID: workspaceID, ActorID: actorID, Verb: "revoked_invite", TargetType: "invite", TargetID: inviteID})
}

func (s *Store) RevokeInvite(ctx context.Context, workspaceID, inviteID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
			return err
		}
		return revokeInviteTx(ctx, tx, workspaceID, inviteID, actorID)
	})
}

func (s *Store) AcceptMyInvite(ctx context.Context, inviteID, userID uuid.UUID) (Membership, error) {
	var m Membership
	err := s.InTx(ctx, func(tx pgx.Tx) error { var err error; m, err = AcceptInviteTx(ctx, tx, inviteID, userID); return err })
	return m, err
}

func (s *Store) AcceptInviteToken(ctx context.Context, token string, userID uuid.UUID) (Membership, error) {
	var id uuid.UUID
	if err := s.pool.QueryRow(ctx, `SELECT id FROM invite WHERE token_hash=$1`, HashToken(token)).Scan(&id); err != nil {
		return Membership{}, mapErr(err)
	}
	return s.AcceptMyInvite(ctx, id, userID)
}

// AcceptInviteTx creates membership and consumes the invite atomically, with
// workspace then invite locks. An existing member always retains their role.
// Invalid, expired, revoked, or already accepted invitations are not found.
func AcceptInviteTx(ctx context.Context, tx pgx.Tx, inviteID, userID uuid.UUID) (Membership, error) {
	var m Membership
	if err := LockInviteWorkspaceTx(ctx, tx, inviteID); err != nil {
		return m, err
	}
	i, err := scanInvite(tx.QueryRow(ctx, `SELECT `+inviteCols+` FROM invite WHERE id=$1 AND `+liveInvite+` FOR UPDATE`, inviteID))
	if err != nil {
		return m, err
	}
	var email string
	if err := tx.QueryRow(ctx, `SELECT email FROM app_user WHERE id=$1`, userID).Scan(&email); err != nil {
		return m, mapErr(err)
	}
	email, err = NormalizeEmail(email)
	if err != nil {
		return m, err
	}
	invitedEmail, err := NormalizeEmail(i.Email)
	if err != nil {
		return m, err
	}
	if email != invitedEmail {
		return m, ErrForbidden
	}
	_, err = tx.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,$3::membership_role) ON CONFLICT(workspace_id,user_id) DO NOTHING`, i.WorkspaceID, userID, i.Role)
	if err != nil {
		return m, err
	}
	err = tx.QueryRow(ctx, `SELECT m.id,m.workspace_id,w.slug,w.name,m.role::text FROM membership m JOIN workspace w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.user_id=$2`, i.WorkspaceID, userID).Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	if err != nil {
		return m, err
	}
	if _, err = tx.Exec(ctx, `UPDATE invite SET accepted_at=now() WHERE id=$1`, i.ID); err != nil {
		return m, err
	}
	err = RecordActivity(ctx, tx, ActivityInput{WorkspaceID: i.WorkspaceID, ActorID: userID, Verb: "accepted_invite", TargetType: "invite", TargetID: i.ID, Metadata: map[string]any{"membership_id": m.ID, "role": m.Role}})
	return m, err
}
