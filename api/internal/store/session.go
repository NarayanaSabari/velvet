package store

import "context"

// DeleteExpiredSessions removes only sessions that can no longer
// authenticate. Live sessions are never touched.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM session WHERE expires_at <= now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
