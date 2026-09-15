package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	apiTokenPrefix = "velvet_"
	apiTokenBytes  = 32
	apiTokenLimit  = 20
)

// APIToken is the safe-to-return metadata for a personal API token. The raw
// token and its hash are deliberately absent from this type.
type APIToken struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

// CreateAPIToken creates a personal token and returns its raw value exactly
// once. Only the SHA-256 hash of the complete velvet_ token is persisted.
func (s *Store) CreateAPIToken(ctx context.Context, userID uuid.UUID, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", ErrInvalidAPITokenName
	}

	raw := make([]byte, apiTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := apiTokenPrefix + hex.EncodeToString(raw)

	err := s.InTx(ctx, func(tx pgx.Tx) error {
		// Serialize the count and insert per user so concurrent issuances cannot
		// exceed the 20-token limit.
		if _, err := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtextextended('api-token-user:' || $1::text, 0))`, userID); err != nil {
			return err
		}

		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM api_token WHERE user_id=$1`, userID).Scan(&count); err != nil {
			return err
		}
		if count >= apiTokenLimit {
			return ErrAPITokenLimit
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO api_token (user_id, name, token_hash)
			VALUES ($1, $2, $3)`, userID, name, HashToken(token))
		return mapErr(err)
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// ListAPITokens returns token metadata only. In particular, token_hash is not
// selected so it cannot accidentally reach an API response.
func (s *Store) ListAPITokens(ctx context.Context, userID uuid.UUID) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, created_at, last_used_at
		FROM api_token
		WHERE user_id=$1
		ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []APIToken{}
	for rows.Next() {
		var token APIToken
		if err := rows.Scan(&token.ID, &token.Name, &token.CreatedAt, &token.LastUsedAt); err != nil {
			return nil, mapErr(err)
		}
		out = append(out, token)
	}
	return out, rows.Err()
}

// DeleteAPIToken removes only a token belonging to userID. An id owned by a
// different user is intentionally indistinguishable from an unknown id.
func (s *Store) DeleteAPIToken(ctx context.Context, userID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM api_token WHERE user_id=$1 AND id=$2`, userID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// LookupAPIToken authenticates rawToken and records use at most once per
// minute. The conditional UPDATE avoids a write on every authenticated API
// request while keeping the first use visible immediately.
func (s *Store) LookupAPIToken(ctx context.Context, rawToken string) (User, error) {
	hash := HashToken(rawToken)
	if _, err := s.pool.Exec(ctx, `
		UPDATE api_token
		SET last_used_at=now()
		WHERE token_hash=$1
		  AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, hash); err != nil {
		return User{}, err
	}

	var user User
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, COALESCE(u.email, ''), u.github_id, u.github_login, u.name, u.avatar_url
		FROM api_token t JOIN app_user u ON u.id=t.user_id
		WHERE t.token_hash=$1`, hash).
		Scan(&user.ID, &user.Email, &user.GitHubID, &user.GitHubLogin, &user.Name, &user.AvatarURL)
	return user, mapErr(err)
}
