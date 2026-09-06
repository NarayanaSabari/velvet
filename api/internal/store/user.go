package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

// WorkspaceMembership is the administrative view of an invite. User stays
// nil until that GitHub login has signed in and claimed the invite.
type WorkspaceMembership struct {
	ID           uuid.UUID `json:"id"`
	WorkspaceID  uuid.UUID `json:"workspace_id"`
	InvitedLogin string    `json:"invited_login"`
	Role         string    `json:"role"`
	User         *User     `json:"user"`
}

const workspaceMembershipCols = `m.id, m.workspace_id, m.invited_login, m.role::text,
	u.id, u.github_id, u.github_login, u.name, u.avatar_url`

func scanWorkspaceMembership(row pgx.Row) (WorkspaceMembership, error) {
	var m WorkspaceMembership
	var userID *uuid.UUID
	var githubID *int64
	var login, name, avatar *string
	err := row.Scan(&m.ID, &m.WorkspaceID, &m.InvitedLogin, &m.Role,
		&userID, &githubID, &login, &name, &avatar)
	if err != nil {
		return m, mapErr(err)
	}
	if userID != nil {
		m.User = &User{ID: *userID}
		if githubID != nil {
			m.User.GitHubID = *githubID
		}
		if login != nil {
			m.User.GitHubLogin = *login
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
		ORDER BY lower(m.invited_login)`, workspaceID)
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
		SELECT u.id, u.github_id, u.github_login, u.name, u.avatar_url
		FROM membership m JOIN app_user u ON u.id = m.user_id
		WHERE m.workspace_id = $1
		ORDER BY lower(u.github_login)`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []User{}
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.GitHubID, &user.GitHubLogin,
			&user.Name, &user.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, user)
	}
	return out, rows.Err()
}

// InviteWorkspaceMember creates an invite. If the login has already used this
// service, it binds the new membership immediately.
func (s *Store) InviteWorkspaceMember(ctx context.Context, workspaceID, actorID uuid.UUID, login, role string) (WorkspaceMembership, error) {
	login = strings.ToLower(strings.TrimSpace(login))
	var out WorkspaceMembership
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO membership (workspace_id, user_id, invited_login, role)
			VALUES ($1,
				(SELECT id FROM app_user WHERE lower(github_login) = lower($2)),
				$2, $3::membership_role)
			ON CONFLICT (workspace_id, lower(invited_login)) DO NOTHING
			RETURNING id`, workspaceID, login, role).Scan(&id); err != nil {
			if errors.Is(mapErr(err), ErrNotFound) {
				return ErrDuplicate
			}
			return mapErr(err)
		}

		var err error
		out, err = scanWorkspaceMembership(tx.QueryRow(ctx, `
			SELECT `+workspaceMembershipCols+`
			FROM membership m LEFT JOIN app_user u ON u.id = m.user_id
			WHERE m.id = $1 AND m.workspace_id = $2`, id, workspaceID))
		if err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbInvitedMember, TargetType: "membership", TargetID: out.ID,
			Metadata: map[string]any{"github_login": out.InvitedLogin, "role": out.Role},
		})
	})
	return out, err
}

func (s *Store) UpdateWorkspaceMembershipRole(ctx context.Context, workspaceID, membershipID, actorID uuid.UUID, role string) (WorkspaceMembership, error) {
	var out WorkspaceMembership
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		// Lock the workspace's membership set so two concurrent demotions cannot
		// both believe another admin will remain.
		rows, err := tx.Query(ctx,
			`SELECT id FROM membership WHERE workspace_id = $1 FOR UPDATE`, workspaceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ignored uuid.UUID
			if err := rows.Scan(&ignored); err != nil {
				rows.Close()
				return err
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		var previousRole, login string
		if err := tx.QueryRow(ctx, `
			SELECT role::text, invited_login FROM membership
			WHERE id = $1 AND workspace_id = $2`, membershipID, workspaceID).
			Scan(&previousRole, &login); err != nil {
			return mapErr(err)
		}
		if previousRole == "admin" && role != "admin" {
			var admins int
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM membership
				WHERE workspace_id = $1 AND role = 'admin'`, workspaceID).Scan(&admins); err != nil {
				return err
			}
			if admins <= 1 {
				return ErrLastAdmin
			}
		}

		if _, err := tx.Exec(ctx, `
			UPDATE membership SET role = $1::membership_role
			WHERE id = $2 AND workspace_id = $3`, role, membershipID, workspaceID); err != nil {
			return mapErr(err)
		}
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
				"github_login": login, "from": previousRole, "to": role,
			},
		})
	})
	return out, err
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
