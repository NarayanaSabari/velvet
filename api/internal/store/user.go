package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          uuid.UUID `json:"id"`
	GitHubID    int64     `json:"github_id"`
	GitHubLogin string    `json:"github_login"`
	Name        string    `json:"name"`
	AvatarURL   string    `json:"avatar_url"`
}

type GitHubIdentity struct {
	ID        int64
	Login     string
	Name      string
	AvatarURL string
}

type Membership struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Slug        string    `json:"workspace_slug"`
	Name        string    `json:"workspace_name"`
	Role        string    `json:"role"`
}

func (s *Store) UpsertUserByGitHub(ctx context.Context, gh GitHubIdentity) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO app_user (github_id, github_login, name, avatar_url)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (github_id) DO UPDATE
		SET github_login = EXCLUDED.github_login,
		    name         = EXCLUDED.name,
		    avatar_url   = EXCLUDED.avatar_url,
		    updated_at   = now()
		RETURNING id, github_id, github_login, name, avatar_url`,
		gh.ID, gh.Login, gh.Name, gh.AvatarURL).
		Scan(&u.ID, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

// BindMembership claims any invite issued to this GitHub login. Invites are
// written before the user has ever signed in, so this is what turns an invite
// into real access.
func (s *Store) BindMembership(ctx context.Context, userID uuid.UUID, login string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE membership SET user_id = $1
		WHERE lower(invited_login) = lower($2) AND user_id IS NULL`, userID, login)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (s *Store) MembershipsForUser(ctx context.Context, userID uuid.UUID) ([]Membership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 ORDER BY w.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Membership
	for rows.Next() {
		var m Membership
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MembershipForSlug(ctx context.Context, userID uuid.UUID, slug string) (Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 AND w.slug = $2`, userID, slug).
		Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	return m, mapErr(err)
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateSession returns the raw token, which is handed to the browser once and
// never stored: the database holds only its hash, so a database leak cannot be
// replayed as a login.
func (s *Store) CreateSession(ctx context.Context, userID uuid.UUID, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session (id, user_id, expires_at) VALUES ($1, $2, now() + $3::interval)`,
		HashToken(token), userID, ttl.String())
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *Store) UserBySessionToken(ctx context.Context, token string) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.name, u.avatar_url
		FROM session s JOIN app_user u ON u.id = s.user_id
		WHERE s.id = $1 AND s.expires_at > now()`, HashToken(token)).
		Scan(&u.ID, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, HashToken(token))
	return err
}
