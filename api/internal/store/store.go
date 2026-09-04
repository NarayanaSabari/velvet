package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrNotFound is returned for a missing row, so callers never have to know
	// that pgx.ErrNoRows exists.
	ErrNotFound = errors.New("not found")
	// ErrInvalidNesting reports the depth guards, which the database enforces
	// with a trigger rather than trusting any one code path.
	ErrInvalidNesting = errors.New("sub-issues may be nested only one level")
	// ErrInvalidCursor reports a pagination cursor the client did not get from
	// this API, which is a client bug rather than a server failure.
	ErrInvalidCursor = errors.New("invalid cursor")
	// ErrDuplicate reports a unique violation, so a handler can answer 409
	// without inspecting driver errors.
	ErrDuplicate = errors.New("already exists")
	// ErrForeignReference reports a reference to a record that belongs to
	// another workspace.
	ErrForeignReference = errors.New("referenced record belongs to another workspace")
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// InTx runs fn inside a transaction, rolling back on error or panic. Every
// mutation that also records activity must go through this.
func (s *Store) InTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrDuplicate
	}
	return err
}
