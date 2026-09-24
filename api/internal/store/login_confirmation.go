package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type LoginResult struct {
	SessionToken string
	Next         string
}

// ConfirmLogin keeps token consumption, identity, invite acceptance, and session
// insertion atomic. Workspace locks precede token and user locks, matching all
// invitation mutation paths.
func (s *Store) ConfirmLogin(ctx context.Context, token string) (LoginResult, error) {
	var result LoginResult
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var inviteID *uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT invite_id FROM login_token WHERE token_hash=$1`, HashToken(token)).Scan(&inviteID); err != nil {
			return mapErr(err)
		}
		if inviteID != nil {
			if err := LockInviteWorkspaceTx(ctx, tx, *inviteID); err != nil {
				return err
			}
		}
		var email string
		// Acquire the token lock before evaluating expiry. An UPDATE may keep
		// its pre-wait predicate when a competing token update rolls back.
		if err := tx.QueryRow(ctx, `SELECT email FROM login_token WHERE token_hash=$1 FOR UPDATE`, HashToken(token)).Scan(&email); err != nil {
			return mapErr(err)
		}
		if err := tx.QueryRow(ctx, `UPDATE login_token SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING email`, HashToken(token)).Scan(&email); err != nil {
			return mapErr(err)
		}
		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO app_user(email) VALUES ($1) ON CONFLICT(lower(email)) DO UPDATE SET email=EXCLUDED.email RETURNING id`, email).Scan(&userID); err != nil {
			return err
		}

		var workspaceID *uuid.UUID
		// Someone with no organisation yet is guided through creating one and
		// connecting their agent, rather than dropped on a blank form.
		result.Next = "/onboarding"
		if inviteID != nil {
			m, err := AcceptInviteTx(ctx, tx, *inviteID, userID)
			if errors.Is(err, ErrForbidden) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			workspaceID = &m.WorkspaceID
			result.Next = "/w/" + m.Slug
		} else {
			var slug string
			err := tx.QueryRow(ctx, `SELECT w.id,w.slug FROM membership m JOIN workspace w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at,w.id LIMIT 1`, userID).Scan(&workspaceID, &slug)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil {
				result.Next = "/w/" + slug
			}
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		result.SessionToken = base64.RawURLEncoding.EncodeToString(raw)
		_, err := tx.Exec(ctx, `INSERT INTO session(id,user_id,last_workspace_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+$4::interval)`, HashToken(result.SessionToken), userID, workspaceID, SessionTTL.String())
		return err
	})
	if err != nil {
		return LoginResult{}, err
	}
	return result, nil
}
