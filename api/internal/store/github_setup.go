package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GitHubAuthorization is request-local claim evidence. Only hashes identify
// persisted state; Verifier is returned once, then erased from storage.
type GitHubAuthorization struct {
	StateHash, SessionHash  string
	UserID                  uuid.UUID
	Purpose, SetupHash      string
	WorkspaceID             uuid.UUID
	WorkspaceSlug           string
	CandidateInstallationID int64
	Verifier                string
	Completed               bool
}

func githubRandom() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func githubSecrets() (state, verifier, challenge string, err error) {
	state, err = githubRandom()
	if err != nil {
		return
	}
	verifier, err = githubRandom()
	if err != nil {
		return
	}
	digest := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(digest[:])
	return
}

// Locks sessions before their child states so logout cannot race completion.
func lockGitHubSessionTx(ctx context.Context, tx pgx.Tx, sessionHash string, userID uuid.UUID) error {
	var id string
	if err := tx.QueryRow(ctx, `SELECT id FROM session WHERE id=$1 AND user_id=$2 FOR SHARE`, sessionHash, userID).Scan(&id); err != nil {
		return mapErr(err)
	}
	return mapErr(tx.QueryRow(ctx, `SELECT id FROM session WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()`, sessionHash, userID).Scan(&id))
}

func (s *Store) CreateGitHubLinkAuthorization(ctx context.Context, session string, userID uuid.UUID) (string, string, error) {
	state, verifier, challenge, err := githubSecrets()
	if err != nil {
		return "", "", err
	}
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockGitHubSessionTx(ctx, tx, HashToken(session), userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,verifier,expires_at) VALUES($1,$2,$3,'link',$4,clock_timestamp()+interval '15 minutes')`, HashToken(state), HashToken(session), userID, verifier)
		return err
	})
	if err != nil {
		return "", "", err
	}
	return state, challenge, nil
}

func (s *Store) CreateGitHubSetup(ctx context.Context, session string, userID, workspaceID uuid.UUID) (string, error) {
	state, err := githubRandom()
	if err != nil {
		return "", err
	}
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, userID); err != nil {
			return err
		}
		if err := lockGitHubSessionTx(ctx, tx, HashToken(session), userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO github_setup_state(token_hash,session_id,user_id,workspace_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')`, HashToken(state), HashToken(session), userID, workspaceID)
		return err
	})
	if err != nil {
		return "", err
	}
	return state, nil
}

func (s *Store) StartGitHubInstallationAuthorization(ctx context.Context, setup, session string, userID uuid.UUID, candidate int64) (string, string, error) {
	if candidate <= 0 {
		return "", "", ErrNotFound
	}
	state, verifier, challenge, err := githubSecrets()
	if err != nil {
		return "", "", err
	}
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		var workspaceID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT workspace_id FROM github_setup_state WHERE token_hash=$1 AND session_id=$2 AND user_id=$3`, HashToken(setup), HashToken(session), userID).Scan(&workspaceID); err != nil {
			return mapErr(err)
		}
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, userID); err != nil {
			return err
		}
		if err := lockGitHubSessionTx(ctx, tx, HashToken(session), userID); err != nil {
			return err
		}
		var hash string
		if err := tx.QueryRow(ctx, `SELECT token_hash FROM github_setup_state WHERE token_hash=$1 FOR UPDATE`, HashToken(setup)).Scan(&hash); err != nil {
			return mapErr(err)
		}
		if err := tx.QueryRow(ctx, `UPDATE github_setup_state SET phase='authorization',claimed_at=clock_timestamp(),candidate_installation_id=$4 WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND expires_at>clock_timestamp() AND phase='installation' AND claimed_at IS NULL AND completed_at IS NULL RETURNING token_hash`, HashToken(setup), HashToken(session), userID, candidate).Scan(&hash); err != nil {
			return mapErr(err)
		}
		_, err := tx.Exec(ctx, `INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,setup_token_hash,verifier,expires_at) SELECT $1,$2,$3,'installation',token_hash,$4,LEAST(expires_at,clock_timestamp()+interval '15 minutes') FROM github_setup_state WHERE token_hash=$5`, HashToken(state), HashToken(session), userID, verifier, hash)
		return err
	})
	if err != nil {
		return "", "", err
	}
	return state, challenge, nil
}

const githubAuthorizationSelect = `SELECT a.token_hash,a.session_id,a.user_id,a.purpose,COALESCE(a.setup_token_hash,''),COALESCE(g.workspace_id,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE(w.slug,''),COALESCE(g.candidate_installation_id,0),a.completed_at IS NOT NULL
 FROM github_authorization_state a JOIN session s ON s.id=a.session_id LEFT JOIN github_setup_state g ON g.token_hash=a.setup_token_hash LEFT JOIN workspace w ON w.id=g.workspace_id
 WHERE a.token_hash=$1 AND a.session_id=$2 AND a.user_id=$3 AND s.user_id=a.user_id AND s.expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()
 AND (a.purpose='link' OR (g.session_id=a.session_id AND g.user_id=a.user_id AND g.expires_at>clock_timestamp() AND g.candidate_installation_id>0 AND g.claimed_at IS NOT NULL AND ((g.phase='authorization' AND g.completed_at IS NULL AND a.completed_at IS NULL) OR (g.phase='completed' AND g.completed_at IS NOT NULL AND a.completed_at IS NOT NULL))))`

func scanGitHubAuthorization(row pgx.Row) (GitHubAuthorization, error) {
	var a GitHubAuthorization
	err := row.Scan(&a.StateHash, &a.SessionHash, &a.UserID, &a.Purpose, &a.SetupHash, &a.WorkspaceID, &a.WorkspaceSlug, &a.CandidateInstallationID, &a.Completed)
	return a, mapErr(err)
}

func (s *Store) GetGitHubAuthorization(ctx context.Context, state, session string, userID uuid.UUID) (GitHubAuthorization, error) {
	return scanGitHubAuthorization(s.pool.QueryRow(ctx, githubAuthorizationSelect, HashToken(state), HashToken(session), userID))
}

func (s *Store) ClaimGitHubAuthorization(ctx context.Context, state, session string, userID uuid.UUID, purpose string) (GitHubAuthorization, error) {
	var a GitHubAuthorization
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockGitHubSessionTx(ctx, tx, HashToken(session), userID); err != nil {
			return err
		}
		var hash string
		if err := tx.QueryRow(ctx, `SELECT token_hash FROM github_authorization_state WHERE token_hash=$1 FOR UPDATE`, HashToken(state)).Scan(&hash); err != nil {
			return mapErr(err)
		}
		var err error
		a, err = scanGitHubAuthorization(tx.QueryRow(ctx, githubAuthorizationSelect, hash, HashToken(session), userID))
		if err != nil {
			return err
		}
		if a.Purpose != purpose || a.Completed {
			return ErrNotFound
		}
		if err := tx.QueryRow(ctx, `SELECT verifier FROM github_authorization_state WHERE token_hash=$1 AND claimed_at IS NULL`, hash).Scan(&a.Verifier); err != nil {
			return mapErr(err)
		}
		_, err = tx.Exec(ctx, `UPDATE github_authorization_state SET claimed_at=clock_timestamp(),verifier='' WHERE token_hash=$1`, hash)
		return err
	})
	if err != nil {
		return GitHubAuthorization{}, err
	}
	return a, nil
}

func lockClaimedGitHubAuthorizationTx(ctx context.Context, tx pgx.Tx, a GitHubAuthorization) error {
	var hash string
	if err := tx.QueryRow(ctx, `SELECT token_hash FROM github_authorization_state WHERE token_hash=$1 FOR UPDATE`, a.StateHash).Scan(&hash); err != nil {
		return mapErr(err)
	}
	return mapErr(tx.QueryRow(ctx, `SELECT token_hash FROM github_authorization_state WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND purpose=$4 AND COALESCE(setup_token_hash,'')=$5 AND claimed_at IS NOT NULL AND completed_at IS NULL AND expires_at>clock_timestamp()
	 AND EXISTS(SELECT 1 FROM session WHERE id=$2 AND user_id=$3 AND expires_at>clock_timestamp())`, a.StateHash, a.SessionHash, a.UserID, a.Purpose, a.SetupHash).Scan(&hash))
}

func (s *Store) CompleteGitHubLink(ctx context.Context, a GitHubAuthorization, identity GitHubIdentity) error {
	if a.Purpose != "link" || a.SetupHash != "" || identity.ID <= 0 || identity.Login == "" {
		return ErrNotFound
	}
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockGitHubSessionTx(ctx, tx, a.SessionHash, a.UserID); err != nil {
			return err
		}
		if err := lockClaimedGitHubAuthorizationTx(ctx, tx, a); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE app_user SET github_id=$1,github_login=$2,updated_at=clock_timestamp() WHERE id=$3`, identity.ID, identity.Login, a.UserID); err != nil {
			return mapErr(err)
		}
		// The user update may have waited for another profile mutation. Recheck
		// both expiries after that wait, rolling the identity update back if dead.
		var hash string
		return mapErr(tx.QueryRow(ctx, `UPDATE github_authorization_state SET completed_at=clock_timestamp(),verifier='' WHERE token_hash=$1 AND expires_at>clock_timestamp()
		 AND EXISTS(SELECT 1 FROM session WHERE id=$2 AND user_id=$3 AND expires_at>clock_timestamp()) RETURNING token_hash`, a.StateHash, a.SessionHash, a.UserID).Scan(&hash))
	})
}

// Task8 calls this before binding, then completes both states in the SAME
// transaction after binding and enqueue. This helper never creates a receipt.
func LockGitHubInstallationAuthorizationTx(ctx context.Context, tx pgx.Tx, a GitHubAuthorization) error {
	if a.Purpose != "installation" || a.SetupHash == "" || a.CandidateInstallationID <= 0 {
		return ErrNotFound
	}
	if err := LockWorkspaceAdminTx(ctx, tx, a.WorkspaceID, a.UserID); err != nil {
		return err
	}
	if err := lockGitHubSessionTx(ctx, tx, a.SessionHash, a.UserID); err != nil {
		return err
	}
	var hash string
	if err := tx.QueryRow(ctx, `SELECT token_hash FROM github_setup_state WHERE token_hash=$1 FOR UPDATE`, a.SetupHash).Scan(&hash); err != nil {
		return mapErr(err)
	}
	if err := tx.QueryRow(ctx, `SELECT token_hash FROM github_setup_state WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND workspace_id=$4 AND candidate_installation_id=$5 AND phase='authorization' AND claimed_at IS NOT NULL AND completed_at IS NULL AND expires_at>clock_timestamp()`, a.SetupHash, a.SessionHash, a.UserID, a.WorkspaceID, a.CandidateInstallationID).Scan(&hash); err != nil {
		return mapErr(err)
	}
	return lockClaimedGitHubAuthorizationTx(ctx, tx, a)
}

func CompleteGitHubInstallationAuthorizationTx(ctx context.Context, tx pgx.Tx, a GitHubAuthorization) error {
	// Revalidate even for callers that omitted the earlier lock helper.
	if err := LockGitHubInstallationAuthorizationTx(ctx, tx, a); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE github_setup_state SET phase='completed',completed_at=clock_timestamp() WHERE token_hash=$1`, a.SetupHash); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE github_authorization_state SET completed_at=clock_timestamp(),verifier='' WHERE token_hash=$1`, a.StateHash)
	return err
}

func (s *Store) CompletedGitHubSetup(ctx context.Context, setup, session string, userID uuid.UUID, candidate int64) (string, error) {
	var slug string
	err := s.pool.QueryRow(ctx, `SELECT w.slug FROM github_setup_state g JOIN workspace w ON w.id=g.workspace_id JOIN session s ON s.id=g.session_id WHERE g.token_hash=$1 AND g.session_id=$2 AND g.user_id=$3 AND g.candidate_installation_id=$4 AND g.phase='completed' AND g.completed_at IS NOT NULL AND g.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND s.user_id=g.user_id`, HashToken(setup), HashToken(session), userID, candidate).Scan(&slug)
	return slug, mapErr(err)
}

func (s *Store) UnlinkGitHub(ctx context.Context, session string, userID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockGitHubSessionTx(ctx, tx, HashToken(session), userID); err != nil {
			return err
		}
		// Users and people projections are read directly from PostgreSQL, with no
		// retained identity cache. No other profile fields are changed.
		_, err := tx.Exec(ctx, `UPDATE app_user SET github_id=NULL,github_login=NULL,updated_at=clock_timestamp() WHERE id=$1`, userID)
		return err
	})
}
