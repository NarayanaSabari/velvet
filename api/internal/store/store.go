package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
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
	// ErrForbidden reports an action the caller is not entitled to take on a
	// record they can otherwise see, such as editing someone else's comment.
	ErrForbidden = errors.New("forbidden")
	// ErrLastAdmin prevents a workspace from losing the only person who can
	// manage its access and repository connections.
	ErrLastAdmin = errors.New("workspace must have at least one admin")
	// ErrRateLimited reports too many login-token requests from one address or
	// source address during the current window.
	ErrRateLimited = errors.New("rate limited")
	// ErrInvalidEmail reports a login address that is not exactly one mailbox.
	ErrInvalidEmail = errors.New("invalid email")
	// ErrInvalidIP reports an address that cannot be canonically represented.
	ErrInvalidIP = errors.New("invalid IP address")
	// ErrInvalidAPITokenName reports a token name that cannot be used.
	ErrInvalidAPITokenName = errors.New("invalid API token name")
	// ErrAPITokenLimit reports that a user already has the maximum number of
	// personal API tokens.
	ErrAPITokenLimit = errors.New("API token limit reached")
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func checkWorkspaceMember(ctx context.Context, tx pgx.Tx, workspaceID, userID uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM membership WHERE workspace_id = $1 AND user_id = $2)`,
		workspaceID, userID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

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
