package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MembershipGitHubIdentity is the GitHub account a person uses inside one
// organisation. Someone working for several clients often has a separate
// account for each, and their work must be recognised as theirs in all of
// them.
type MembershipGitHubIdentity struct {
	WorkspaceID uuid.UUID `json:"workspace_id"`
	UserID      uuid.UUID `json:"user_id"`
	GitHubID    int64     `json:"github_id"`
	GitHubLogin string    `json:"github_login"`
	LinkedAt    string    `json:"linked_at"`
}

// LinkMembershipGitHubIdentity records the GitHub account the caller uses in
// this organisation, and re-attributes the pull requests and reviews already
// synced under that login.
func (s *Store) LinkMembershipGitHubIdentity(ctx context.Context, workspaceID, userID uuid.UUID, identity GitHubIdentity) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		return linkMembershipIdentityTx(ctx, tx, workspaceID, userID, identity)
	})
}

// linkMembershipIdentityTx is the single implementation, so a link completed
// through the GitHub authorization flow and one recorded directly cannot drift
// apart.
//
// Back-filling matters: evidence usually arrives before anyone links an
// account, so without it the work done up to that point would stay credited to
// nobody.
func linkMembershipIdentityTx(ctx context.Context, tx pgx.Tx, workspaceID, userID uuid.UUID, identity GitHubIdentity) error {
	if identity.ID <= 0 || identity.Login == "" {
		return ErrNotFound
	}

	var membershipID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM membership WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID, userID).Scan(&membershipID); err != nil {
		return mapErr(err)
	}

	// A GitHub account already claimed by someone else in this organisation
	// would make attribution ambiguous, so it is refused rather than silently
	// reassigned.
	var claimedBy uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT user_id FROM membership_github_identity
		 WHERE workspace_id = $1 AND github_id = $2`,
		workspaceID, identity.ID).Scan(&claimedBy)
	switch {
	case err == nil && claimedBy != userID:
		return ErrDuplicate
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO membership_github_identity
			(membership_id, workspace_id, user_id, github_id, github_login)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (membership_id) DO UPDATE SET
			github_id = EXCLUDED.github_id,
			github_login = EXCLUDED.github_login,
			linked_at = now()`,
		membershipID, workspaceID, userID, identity.ID, identity.Login); err != nil {
		return mapErr(err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE pull_request SET author_id = $2
		WHERE workspace_id = $1 AND lower(author_login) = lower($3)
		  AND author_id IS DISTINCT FROM $2`,
		workspaceID, userID, identity.Login); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE pr_review SET reviewer_id = $2
		WHERE workspace_id = $1 AND lower(reviewer_login) = lower($3)
		  AND reviewer_id IS DISTINCT FROM $2`,
		workspaceID, userID, identity.Login); err != nil {
		return err
	}

	return RecordActivity(ctx, tx, ActivityInput{
		WorkspaceID: workspaceID, ActorID: userID,
		Verb: VerbLinkedGitHubIdentity, TargetType: "membership", TargetID: membershipID,
		Metadata: map[string]any{"github_login": identity.Login},
	})
}

// UnlinkMembershipGitHubIdentity removes the per-organisation account. The
// evidence it attributed is kept: work that happened still happened.
func (s *Store) UnlinkMembershipGitHubIdentity(ctx context.Context, workspaceID, userID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var membershipID uuid.UUID
		err := tx.QueryRow(ctx, `
			DELETE FROM membership_github_identity
			WHERE workspace_id = $1 AND user_id = $2
			RETURNING membership_id`, workspaceID, userID).Scan(&membershipID)
		if err != nil {
			return mapErr(err)
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: userID,
			Verb: VerbUnlinkedGitHubIdentity, TargetType: "membership", TargetID: membershipID,
		})
	})
}

// GitHubIdentityForMembership reports the account that would actually
// attribute this person's work in this organisation: the organisation-specific
// one when set, otherwise their global profile. Reporting only the former
// would tell most people they have no identity when their work is in fact
// being attributed correctly.
func (s *Store) GitHubIdentityForMembership(ctx context.Context, workspaceID, userID uuid.UUID) (MembershipGitHubIdentity, error) {
	var out MembershipGitHubIdentity
	err := s.pool.QueryRow(ctx, `
		SELECT $1::uuid, $2::uuid,
		       COALESCE(gi.github_id, u.github_id),
		       COALESCE(gi.github_login, u.github_login),
		       to_char(COALESCE(gi.linked_at, u.updated_at), 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM')
		FROM app_user u
		JOIN membership m ON m.user_id = u.id AND m.workspace_id = $1
		LEFT JOIN membership_github_identity gi ON gi.membership_id = m.id
		WHERE u.id = $2
		  AND COALESCE(gi.github_id, u.github_id) IS NOT NULL`,
		workspaceID, userID).Scan(&out.WorkspaceID, &out.UserID,
		&out.GitHubID, &out.GitHubLogin, &out.LinkedAt)
	return out, mapErr(err)
}
