package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// maxJobAttempts is where retrying stops. A job that has failed five times is
// failing for a reason a sixth attempt will not change, so it is dead-lettered
// and left in the table for a human to look at.
const maxJobAttempts = 5

// Job is one unit of background work. Payload stays raw so the queue does not
// need to know any handler's shape.
type Job struct {
	ID       int64
	Kind     string
	Payload  []byte
	Attempts int
}

// EnqueueJob takes a tx so the job is committed with the row that justifies
// it: a stored delivery always has a job, and a job never references a
// delivery that was rolled back.
func (s *Store) EnqueueJob(ctx context.Context, tx pgx.Tx, kind string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode job payload: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO job (kind, payload) VALUES ($1, $2)`, kind, body)
	return err
}

// ClaimJob takes the oldest ready job, or returns ErrNotFound when the queue
// is empty. FOR UPDATE SKIP LOCKED lets several workers drain the queue
// without two of them ever claiming the same row.
//
// The claim pushes run_after five minutes out, so a worker that crashes
// mid-job releases its work automatically rather than losing it.
func (s *Store) ClaimJob(ctx context.Context) (Job, error) {
	var j Job
	err := s.pool.QueryRow(ctx, `
		UPDATE job SET run_after = now() + interval '5 minutes', attempts = attempts + 1
		WHERE id = (
			SELECT id FROM job
			WHERE NOT dead AND run_after <= now()
			ORDER BY run_after
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING id, kind, payload, attempts`).
		Scan(&j.ID, &j.Kind, &j.Payload, &j.Attempts)
	return j, mapErr(err)
}

// CompleteJob removes a finished job. Deleting rather than flagging keeps the
// ready index small, which is what makes the claim query cheap forever.
func (s *Store) CompleteJob(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM job WHERE id = $1`, id)
	return err
}

// FailJob schedules a retry with exponential backoff, capped at an hour, and
// dead-letters the job once it has burned its attempts. The reason is stored
// so a dead job explains itself without a log search.
func (s *Store) FailJob(ctx context.Context, id int64, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE job
		SET last_error = $2,
		    dead = attempts >= $3,
		    run_after = now() + least(power(2, attempts) * interval '1 second',
		                              interval '1 hour')
		WHERE id = $1`, id, reason, maxJobAttempts)
	return err
}
