package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// RecordDelivery persists the raw payload and enqueues its job atomically, so
// a stored delivery always has a job and an enqueued job always has a payload.
// Deduplication is by GitHub's delivery ID, which makes a redelivery after an
// outage a no-op rather than a second round of activity rows.
func (s *Store) RecordDelivery(ctx context.Context, deliveryID, eventType string, payload []byte) (bool, error) {
	isNew := false
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO github_event (delivery_id, event_type, payload)
			VALUES ($1, $2, $3)
			ON CONFLICT (delivery_id) DO NOTHING`, deliveryID, eventType, payload)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		isNew = true
		return s.EnqueueJob(ctx, tx, "process_delivery",
			map[string]any{"delivery_id": deliveryID})
	})
	return isNew, err
}
