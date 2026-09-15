package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type User struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	GitHubID    *int64    `json:"github_id"`
	GitHubLogin *string   `json:"github_login"`
	Name        string    `json:"name"`
	AvatarURL   string    `json:"avatar_url"`
}

type GitHubIdentity struct {
	ID        int64
	Login     string
	Name      string
	AvatarURL string
}

type scanner interface {
	Scan(...any) error
}

func scanUser(row scanner, user *User) error {
	return mapErr(row.Scan(&user.ID, &user.Email, &user.GitHubID, &user.GitHubLogin,
		&user.Name, &user.AvatarURL))
}

type Membership struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Slug        string    `json:"workspace_slug"`
	Name        string    `json:"workspace_name"`
	IssuePrefix string    `json:"issue_prefix"`
	Role        string    `json:"role"`
}

// WorkspaceMembership is the administrative view of a current member.
type WorkspaceMembership struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Role        string    `json:"role"`
	User        *User     `json:"user"`
}

const workspaceMembershipCols = `m.id, m.workspace_id, m.role::text,
	u.id, u.email, u.github_id, u.github_login, u.name, u.avatar_url`

func scanWorkspaceMembership(row pgx.Row) (WorkspaceMembership, error) {
	var m WorkspaceMembership
	var userID *uuid.UUID
	var email, login, name, avatar *string
	var githubID *int64
	err := row.Scan(&m.ID, &m.WorkspaceID, &m.Role,
		&userID, &email, &githubID, &login, &name, &avatar)
	if err != nil {
		return m, mapErr(err)
	}
	if userID != nil {
		m.User = &User{ID: *userID, GitHubID: githubID, GitHubLogin: login}
		if email != nil {
			m.User.Email = *email
		}
		if name != nil {
			m.User.Name = *name
		}
		if avatar != nil {
			m.User.AvatarURL = *avatar
		}
	}
	return m, nil
}

func (s *Store) ListWorkspaceMemberships(ctx context.Context, workspaceID uuid.UUID) ([]WorkspaceMembership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+workspaceMembershipCols+`
		FROM membership m LEFT JOIN app_user u ON u.id = m.user_id
		WHERE m.workspace_id = $1
		ORDER BY lower(u.email)`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []WorkspaceMembership{}
	for rows.Next() {
		m, err := scanWorkspaceMembership(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListWorkspaceMembers is the read-only people projection used by assignee
// selectors. Pending invites are absent because they do not identify a user.
func (s *Store) ListWorkspaceMembers(ctx context.Context, workspaceID uuid.UUID) ([]User, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id, COALESCE(u.email, ''), u.github_id, u.github_login, u.name, u.avatar_url
		FROM membership m JOIN app_user u ON u.id = m.user_id
		WHERE m.workspace_id = $1
		ORDER BY lower(COALESCE(u.github_login, u.email))`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []User{}
	for rows.Next() {
		var user User
		if err := scanUser(rows, &user); err != nil {
			return nil, err
		}
		out = append(out, user)
	}
	return out, rows.Err()
}

func (s *Store) UpdateWorkspaceMembershipRole(ctx context.Context, workspaceID, membershipID, actorID uuid.UUID, role string) (WorkspaceMembership, error) {
	var out WorkspaceMembership
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}

		var previousRole, email string
		if err := tx.QueryRow(ctx, `
			SELECT m.role::text, u.email FROM membership m JOIN app_user u ON u.id = m.user_id
			WHERE m.id = $1 AND m.workspace_id = $2`, membershipID, workspaceID).
			Scan(&previousRole, &email); err != nil {
			return mapErr(err)
		}
		if previousRole == "admin" && role != "admin" {
			if err := retainAdminTx(ctx, tx, workspaceID, previousRole); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(ctx, `
			UPDATE membership SET role = $1::membership_role
			WHERE id = $2 AND workspace_id = $3`, role, membershipID, workspaceID); err != nil {
			return mapErr(err)
		}
		var err error
		out, err = scanWorkspaceMembership(tx.QueryRow(ctx, `
			SELECT `+workspaceMembershipCols+`
			FROM membership m LEFT JOIN app_user u ON u.id = m.user_id
			WHERE m.id = $1 AND m.workspace_id = $2`, membershipID, workspaceID))
		if err != nil {
			return err
		}
		if previousRole == role {
			return nil
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbChangedMemberRole, TargetType: "membership", TargetID: out.ID,
			Metadata: map[string]any{
				"email": email, "from": previousRole, "to": role,
			},
		})
	})
	return out, err
}

// UpsertUserByEmail finds or creates the normalized email identity. The
// expression conflict target matches the database's case-insensitive index.
func (s *Store) UpsertUserByEmail(ctx context.Context, email string) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var u User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO app_user (email)
		VALUES ($1)
		ON CONFLICT (lower(email)) DO UPDATE SET email = EXCLUDED.email
		RETURNING id, email, github_id, github_login, name, avatar_url`, email).
		Scan(&u.ID, &u.Email, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

func (s *Store) MembershipsForUser(ctx context.Context, userID uuid.UUID) ([]Membership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, w.issue_prefix, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 ORDER BY w.created_at,w.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Membership{}
	for rows.Next() {
		var m Membership
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.IssuePrefix, &m.Role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MembershipForSlug(ctx context.Context, userID uuid.UUID, slug string) (Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, w.issue_prefix, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 AND w.slug = $2`, userID, slug).
		Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.IssuePrefix, &m.Role)
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
		SELECT u.id, COALESCE(u.email, ''), u.github_id, u.github_login, u.name, u.avatar_url
		FROM session s JOIN app_user u ON u.id = s.user_id
		WHERE s.id = $1 AND s.expires_at > now()`, HashToken(token)).
		Scan(&u.ID, &u.Email, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, HashToken(token))
	return err
}
