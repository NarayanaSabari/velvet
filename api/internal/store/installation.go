package store

import (
	"context"
	"errors"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInstallationConflict  = errors.New("installation binding conflict")
	ErrRepositoryConflict    = errors.New("repository ownership conflict")
	ErrVerificationRequired  = errors.New("verification required")
	ErrStaleInstallationSync = errors.New("stale installation sync")
)

type InstallationSync struct {
	InstallationID int64     `json:"installation_id"`
	WorkspaceID    uuid.UUID `json:"workspace_id"`
	Generation     int64     `json:"generation"`
}

type Installation struct {
	ID                  int64      `json:"id"`
	AccountLogin        string     `json:"account_login"`
	OwnershipVerifiedAt *time.Time `json:"ownership_verified_at"`
	ReposSyncedAt       *time.Time `json:"repos_synced_at"`
	SuspendedAt         *time.Time `json:"suspended_at"`
	DeletedAt           *time.Time `json:"deleted_at"`
}

type InstallationStatus struct {
	Installation *Installation `json:"installation"`
	Status       string        `json:"status"`
	Error        *string       `json:"error"`
}

// BindInstallation only accepts evidence produced by the user authorization
// flow. Its claim is rechecked under locks before any binding can commit.
func (s *Store) BindInstallation(ctx context.Context, a GitHubAuthorization, evidence github.VerifiedInstallation) error {
	if evidence.ID != a.CandidateInstallationID || evidence.ID <= 0 || evidence.AccountID <= 0 || evidence.AccountLogin == "" || (evidence.AccountType != "User" && evidence.AccountType != "Organization") {
		return ErrNotFound
	}
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockGitHubInstallationAuthorizationTx(ctx, tx, a); err != nil {
			return err
		}
		// There may be no installation row yet. The transaction advisory lock also
		// serializes contenders in different workspaces before that first INSERT.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, evidence.ID); err != nil {
			return err
		}
		var owner *uuid.UUID
		err := tx.QueryRow(ctx, `SELECT workspace_id FROM github_installation WHERE id=$1 FOR UPDATE`, evidence.ID).Scan(&owner)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if owner != nil && *owner != a.WorkspaceID {
			return ErrInstallationConflict
		}
		var existing int64
		var deleted *time.Time
		err = tx.QueryRow(ctx, `SELECT id,deleted_at FROM github_installation WHERE workspace_id=$1 FOR UPDATE`, a.WorkspaceID).Scan(&existing, &deleted)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && existing != evidence.ID {
			if deleted == nil {
				return ErrInstallationConflict
			}
			// Retain the old installation and repository evidence. Only a confirmed
			// deleted binding can release the organisation's single active slot.
			if _, err := tx.Exec(ctx, `UPDATE github_installation SET workspace_id=NULL,sync_generation=sync_generation+1 WHERE id=$1`, existing); err != nil {
				return err
			}
		}
		job := InstallationSync{InstallationID: evidence.ID, WorkspaceID: a.WorkspaceID}
		err = tx.QueryRow(ctx, `INSERT INTO github_installation(id,account_login,workspace_id,ownership_verified_at,sync_generation)
   VALUES ($1,$2,$3,clock_timestamp(),1)
   ON CONFLICT(id) DO UPDATE SET account_login=EXCLUDED.account_login,workspace_id=EXCLUDED.workspace_id,
    ownership_verified_at=clock_timestamp(),deleted_at=NULL,repos_synced_at=NULL,sync_error=NULL,sync_generation=github_installation.sync_generation+1
   RETURNING sync_generation`, evidence.ID, evidence.AccountLogin, a.WorkspaceID).Scan(&job.Generation)
		if err != nil {
			return err
		}
		if err := s.EnqueueJob(ctx, tx, "sync_installation_repos", job); err != nil {
			return err
		}
		return CompleteGitHubInstallationAuthorizationTx(ctx, tx, a)
	})
	if errors.Is(mapErr(err), ErrDuplicate) {
		return ErrInstallationConflict
	}
	return err
}

func (s *Store) GitHubStatus(ctx context.Context, workspaceID uuid.UUID) (InstallationStatus, error) {
	out := InstallationStatus{Status: "disconnected"}
	var i Installation
	var syncError *string
	err := s.pool.QueryRow(ctx, `SELECT id,account_login,ownership_verified_at,repos_synced_at,suspended_at,deleted_at,sync_error FROM github_installation WHERE workspace_id=$1`, workspaceID).
		Scan(&i.ID, &i.AccountLogin, &i.OwnershipVerifiedAt, &i.ReposSyncedAt, &i.SuspendedAt, &i.DeletedAt, &syncError)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Installation = &i
	switch {
	case i.DeletedAt != nil:
		out.Status = "disconnected"
	case i.OwnershipVerifiedAt == nil:
		out.Status = "error"
		value := "verification_required"
		out.Error = &value
	case i.SuspendedAt != nil:
		out.Status = "suspended"
	case syncError != nil:
		out.Status = "error"
		value := safeInstallationError(*syncError)
		out.Error = &value
	case i.ReposSyncedAt == nil:
		out.Status = "syncing"
	default:
		out.Status = "connected"
	}
	return out, nil
}

func safeInstallationError(code string) string {
	if code == "repository_conflict" {
		return code
	}
	return "sync_failed"
}

func (s *Store) RequestInstallationSync(ctx context.Context, workspaceID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceAdminTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		return s.enqueueInstallationSyncTx(ctx, tx, workspaceID, 0)
	})
}

// The event and scheduler entry points deliberately skip migrated bindings.
// Only successful owner authorization can set ownership_verified_at.
func (s *Store) RequestInstallationSyncForEvent(ctx context.Context, installationID int64) error {
	var workspaceID uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM github_installation WHERE id=$1 AND workspace_id IS NOT NULL AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL`, installationID).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
			return err
		}
		return s.enqueueInstallationSyncTx(ctx, tx, workspaceID, installationID)
	})
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrVerificationRequired) || errors.Is(err, ErrStaleInstallationSync) {
		return nil
	}
	return err
}

func (s *Store) enqueueInstallationSyncTx(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, expectedID int64) error {
	var id int64
	var verified, deleted, suspended *time.Time
	err := tx.QueryRow(ctx, `SELECT id,ownership_verified_at,deleted_at,suspended_at FROM github_installation WHERE workspace_id=$1 FOR UPDATE`, workspaceID).Scan(&id, &verified, &deleted, &suspended)
	if err != nil {
		return mapErr(err)
	}
	if expectedID != 0 && expectedID != id {
		return ErrStaleInstallationSync
	}
	if verified == nil {
		return ErrVerificationRequired
	}
	if deleted != nil || suspended != nil {
		return ErrStaleInstallationSync
	}
	job := InstallationSync{InstallationID: id, WorkspaceID: workspaceID}
	err = tx.QueryRow(ctx, `UPDATE github_installation SET sync_generation=sync_generation+1,repos_synced_at=NULL,sync_error=NULL WHERE id=$1 RETURNING sync_generation`, id).Scan(&job.Generation)
	if err != nil {
		return err
	}
	return s.EnqueueJob(ctx, tx, "sync_installation_repos", job)
}

func (s *Store) ScheduleInstallationSyncs(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM github_installation WHERE workspace_id IS NOT NULL AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL AND (repos_synced_at IS NULL OR repos_synced_at<now()-interval '1 hour')
  AND NOT EXISTS (SELECT 1 FROM job WHERE kind='sync_installation_repos' AND NOT dead AND (payload->>'installation_id')::bigint=github_installation.id)`)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.RequestInstallationSyncForEvent(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) InstallationSyncCurrent(ctx context.Context, job InstallationSync) (bool, error) {
	var current bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_installation WHERE id=$1 AND workspace_id=$2 AND sync_generation=$3 AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL)`, job.InstallationID, job.WorkspaceID, job.Generation).Scan(&current)
	return current, err
}

// ApplyInstallationRepos commits a complete provider listing as one unit.
// A foreign historical row is still foreign, and aborts every preceding upsert.
func (s *Store) ApplyInstallationRepos(ctx context.Context, job InstallationSync, repos []github.Repository) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, job.WorkspaceID); err != nil {
			return err
		}
		var id int64
		err := tx.QueryRow(ctx, `SELECT id FROM github_installation WHERE id=$1 AND workspace_id=$2 AND sync_generation=$3 AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL FOR UPDATE`, job.InstallationID, job.WorkspaceID, job.Generation).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrStaleInstallationSync
		}
		if err != nil {
			return err
		}
		for _, repo := range repos {
			branch := repo.DefaultBranch
			if branch == "" {
				branch = "main"
			}
			var id uuid.UUID
			err := tx.QueryRow(ctx, `INSERT INTO repo(workspace_id,installation_id,github_id,owner,name,default_branch) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT(github_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,owner=EXCLUDED.owner,name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,disconnected_at=NULL
    WHERE repo.workspace_id=EXCLUDED.workspace_id RETURNING id`, job.WorkspaceID, job.InstallationID, repo.ID, repo.Owner, repo.Name, branch).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrRepositoryConflict
			}
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `UPDATE github_installation SET repos_synced_at=clock_timestamp(),sync_error=NULL WHERE id=$1`, job.InstallationID)
		return err
	})
}

func (s *Store) FailInstallationSync(ctx context.Context, job InstallationSync, code string) error {
	_, err := s.pool.Exec(ctx, `UPDATE github_installation SET sync_error=$4 WHERE id=$1 AND workspace_id=$2 AND sync_generation=$3`, job.InstallationID, job.WorkspaceID, job.Generation, safeInstallationError(code))
	return err
}
