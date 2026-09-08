package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionTTL is shared by session creation and browser cookie expiry.
const SessionTTL = 30 * 24 * time.Hour

// DeleteExpiredSessions removes only sessions that can no longer
// authenticate. Live sessions are never touched.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM session WHERE expires_at <= now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CleanupExpiredAuthentication does bounded maintenance, preserving recent
// issuance counters and every live token. Invitations are retained for audit.
func (s *Store) CleanupExpiredAuthentication(ctx context.Context) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		queries := []string{
			`DELETE FROM login_token WHERE token_hash IN (
			 SELECT token_hash FROM login_token WHERE expires_at<=now()
			 AND created_at<=now()-interval '15 minutes' ORDER BY expires_at,token_hash LIMIT 1000 FOR UPDATE SKIP LOCKED)`,
			`DELETE FROM github_authorization_state WHERE token_hash IN (
			 SELECT token_hash FROM github_authorization_state WHERE expires_at<=now()
			 ORDER BY expires_at,token_hash LIMIT 1000 FOR UPDATE SKIP LOCKED)`,
		}
		for _, query := range queries {
			if _, err := tx.Exec(ctx, query); err != nil {
				return err
			}
		}
		// Lock parents before checking their children in a fresh statement
		// snapshot. A child committed during candidate selection must survive;
		// the parent locks prevent new foreign-key references during deletion.
		rows, err := tx.Query(ctx, `SELECT s.token_hash FROM github_setup_state s WHERE s.expires_at<=now()
		 AND NOT EXISTS(SELECT 1 FROM github_authorization_state a WHERE a.setup_token_hash=s.token_hash)
		 ORDER BY s.expires_at,s.token_hash LIMIT 1000 FOR UPDATE SKIP LOCKED`)
		if err != nil {
			return err
		}
		hashes, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM github_setup_state s WHERE s.token_hash=ANY($1)
		 AND NOT EXISTS(SELECT 1 FROM github_authorization_state a WHERE a.setup_token_hash=s.token_hash)`, hashes)
		return err
	})
}
