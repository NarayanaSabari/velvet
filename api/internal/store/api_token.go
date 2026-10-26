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
	apiTokenPrefix   = "velvet_"
	setupTokenPrefix = "velvetsetup_"
	apiTokenBytes    = 32
	apiTokenLimit    = 20
)

// APIToken is safe-to-return metadata for any API token kind. The raw
// token and its hash are deliberately absent from this type.
type APIToken struct {
	Kind       string     `json:"kind"`
	ParentID   *uuid.UUID `json:"parent_id,omitempty"`
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	// A key minted by `velvet init` is bound to one organisation and project.
	// Both are nil for a personal key.
	WorkspaceSlug *string `json:"workspace_slug"`
	ProjectKey    *string `json:"project_key"`
}

// TokenScope is what a key may reach. A zero scope mints a personal key.
// Setup keys are unscoped but default-denied by their explicit kind.
// Desktop credentials are unscoped and use current membership roles, like the app.
type TokenScope struct {
	Kind        string
	ParentID    *uuid.UUID
	WorkspaceID *uuid.UUID
	ProjectID   *uuid.UUID
}

func (s TokenScope) Scoped() bool { return s.ProjectID != nil }

// Setup hashes use a distinct domain so binaries predating kind enforcement
// cannot authenticate these credentials as unrestricted personal tokens.
func apiTokenHash(raw string) string {
	if strings.HasPrefix(raw, setupTokenPrefix) {
		return HashToken("cli-setup:" + raw)
	}
	return HashToken(raw)
}

// CreateAPIToken creates a personal token and returns its raw value exactly
// once. Only the SHA-256 hash of the complete velvet_ token is persisted.
func (s *Store) CreateAPIToken(ctx context.Context, userID uuid.UUID, name string) (string, error) {
	var token string
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var err error
		token, _, err = createAPITokenTx(ctx, tx, userID, name, TokenScope{})
		return err
	})
	return token, err
}

// createAPITokenTx mints a key inside the caller's transaction. Only its hash
// is persisted, with a separate hash domain for machine setup credentials.
func createAPITokenTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, name string, scope TokenScope) (string, uuid.UUID, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", uuid.Nil, ErrInvalidAPITokenName
	}

	raw := make([]byte, apiTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", uuid.Nil, err
	}
	prefix := apiTokenPrefix
	if scope.Kind == "setup" {
		prefix = setupTokenPrefix
	}
	token := prefix + hex.EncodeToString(raw)

	// Serialize the count and insert per user so concurrent issuances cannot
	// exceed the 20-token limit.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('api-token-user:' || $1::text, 0))`, userID); err != nil {
		return "", uuid.Nil, err
	}

	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM api_token WHERE user_id=$1`, userID).Scan(&count); err != nil {
		return "", uuid.Nil, err
	}
	if count >= apiTokenLimit {
		return "", uuid.Nil, ErrAPITokenLimit
	}

	if scope.Kind == "" {
		scope.Kind = "personal"
		if scope.Scoped() {
			scope.Kind = "project"
		}
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO api_token (user_id, name, token_hash, workspace_id, project_id, kind, parent_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		userID, name, apiTokenHash(token), scope.WorkspaceID, scope.ProjectID, scope.Kind, scope.ParentID).Scan(&id)
	if err != nil {
		return "", uuid.Nil, mapErr(err)
	}
	return token, id, nil
}

// ListAPITokens returns token metadata only. In particular, token_hash is not
// selected so it cannot accidentally reach an API response.
func (s *Store) ListAPITokens(ctx context.Context, userID uuid.UUID) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.name, t.created_at, t.last_used_at, w.slug, p.key, t.kind, t.parent_id
		FROM api_token t
		LEFT JOIN workspace w ON w.id = t.workspace_id
		LEFT JOIN project p ON p.id = t.project_id
		WHERE t.user_id=$1
		ORDER BY t.created_at, t.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []APIToken{}
	for rows.Next() {
		var token APIToken
		if err := rows.Scan(&token.ID, &token.Name, &token.CreatedAt, &token.LastUsedAt, &token.WorkspaceSlug, &token.ProjectKey, &token.Kind, &token.ParentID); err != nil {
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
//
// The token's own id is returned alongside the user so a work-log entry can
// record which agent token wrote it, and its scope so every request can be
// held to the organisation and project the key was minted for.
func (s *Store) LookupAPIToken(ctx context.Context, rawToken string) (User, uuid.UUID, TokenScope, error) {
	hash := apiTokenHash(rawToken)
	if _, err := s.pool.Exec(ctx, `
		UPDATE api_token
		SET last_used_at=now()
		WHERE token_hash=$1
		  AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, hash); err != nil {
		return User{}, uuid.Nil, TokenScope{}, err
	}

	var user User
	var tokenID uuid.UUID
	var scope TokenScope
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.workspace_id, t.project_id, t.kind, t.parent_id, u.id, COALESCE(u.email, ''), u.github_id, u.github_login, u.name, u.avatar_url
		FROM api_token t JOIN app_user u ON u.id=t.user_id
		WHERE t.token_hash=$1`, hash).
		Scan(&tokenID, &scope.WorkspaceID, &scope.ProjectID, &scope.Kind, &scope.ParentID, &user.ID, &user.Email, &user.GitHubID, &user.GitHubLogin, &user.Name, &user.AvatarURL)
	return user, tokenID, scope, mapErr(err)
}

// RevokeAPITokenByID deletes the key that authenticated a request, which is
// how `velvet logout` removes its own key without a browser session.
func (s *Store) RevokeAPITokenByID(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM api_token WHERE id=$1`, id)
	return err
}
