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
		var tombstone *time.Time
		err := tx.QueryRow(ctx, `SELECT workspace_id,deleted_at FROM github_installation WHERE id=$1 FOR UPDATE`, evidence.ID).Scan(&owner, &tombstone)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if owner != nil && *owner != a.WorkspaceID {
			return ErrInstallationConflict
		}
		if tombstone != nil {
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
		var suspended *time.Time
		err = tx.QueryRow(ctx, `INSERT INTO github_installation(id,account_login,workspace_id,ownership_verified_at,sync_generation)
   VALUES ($1,$2,$3,clock_timestamp(),1)
   ON CONFLICT(id) DO UPDATE SET account_login=EXCLUDED.account_login,workspace_id=EXCLUDED.workspace_id,
    ownership_verified_at=clock_timestamp(),repos_synced_at=NULL,sync_error=NULL,sync_generation=github_installation.sync_generation+1
   RETURNING sync_generation,suspended_at`, evidence.ID, evidence.AccountLogin, a.WorkspaceID).Scan(&job.Generation, &suspended)
		if err != nil {
			return err
		}
		kind := "sync_installation_repos"
		if suspended != nil {
			kind = "sync_installation_state"
		}
		if err := s.EnqueueJob(ctx, tx, kind, job); err != nil {
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
		if syncError != nil {
			value := safeInstallationError(*syncError)
			out.Error = &value
		}
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
		return s.enqueueInstallationSyncTx(ctx, tx, workspaceID, 0, true)
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
		return s.enqueueInstallationSyncTx(ctx, tx, workspaceID, installationID, false)
	})
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrVerificationRequired) || errors.Is(err, ErrStaleInstallationSync) {
		return nil
	}
	return err
}

func (s *Store) enqueueInstallationSyncTx(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, expectedID int64, retrySuspended bool) error {
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
	if deleted != nil || (suspended != nil && !retrySuspended) {
		return ErrStaleInstallationSync
	}
	job := InstallationSync{InstallationID: id, WorkspaceID: workspaceID}
	err = tx.QueryRow(ctx, `UPDATE github_installation SET sync_generation=sync_generation+1,repos_synced_at=NULL,sync_error=NULL WHERE id=$1 RETURNING sync_generation`, id).Scan(&job.Generation)
	if err != nil {
		return err
	}
	kind := "sync_installation_repos"
	if suspended != nil {
		kind = "sync_installation_state"
	}
	return s.EnqueueJob(ctx, tx, kind, job)
}

func (s *Store) ScheduleInstallationSyncs(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM github_installation WHERE workspace_id IS NOT NULL AND ownership_verified_at IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL AND sync_error IS NULL AND (repos_synced_at IS NULL OR repos_synced_at<now()-interval '1 hour')
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
	var failures []error
	for _, id := range ids {
		if err := s.RequestInstallationSyncForEvent(ctx, id); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
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
		ids := make([]int64, 0, len(repos))
		for _, repo := range repos {
			ids = append(ids, repo.ID)
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
		if _, err := tx.Exec(ctx, `UPDATE repo SET disconnected_at=COALESCE(disconnected_at,clock_timestamp()) WHERE workspace_id=$1 AND installation_id=$2 AND NOT (github_id=ANY($3::bigint[]))`, job.WorkspaceID, job.InstallationID, ids); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE github_installation SET repos_synced_at=clock_timestamp(),sync_error=NULL WHERE id=$1`, job.InstallationID)
		return err
	})
}

func (s *Store) FailInstallationSync(ctx context.Context, job InstallationSync, code string) error {
	_, err := s.pool.Exec(ctx, `UPDATE github_installation SET sync_error=$4 WHERE id=$1 AND workspace_id=$2 AND sync_generation=$3`, job.InstallationID, job.WorkspaceID, job.Generation, safeInstallationError(code))
	return err
}

// InstallationEvent serializes lifecycle changes with binding, retry, snapshot
// application, and evidence writes. A deleted installation ID is terminal.
// Suspension events return a generation to reconcile against the provider.
func (s *Store) InstallationEvent(ctx context.Context, id int64, login, action string) (InstallationSync, bool, error) {
	job := InstallationSync{InstallationID: id}
	var owner *uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM github_installation WHERE id=$1`, id).Scan(&owner)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return job, false, err
	}
	if owner != nil {
		job.WorkspaceID = *owner
	}
	check := false
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if owner != nil {
			if err := lockWorkspaceTx(ctx, tx, *owner); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO github_installation(id,account_login) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, id, login); err != nil {
			return err
		}
		var currentOwner *uuid.UUID
		var deleted, suspended, verified *time.Time
		if err := tx.QueryRow(ctx, `SELECT workspace_id,deleted_at,suspended_at,ownership_verified_at,sync_generation FROM github_installation WHERE id=$1 FOR UPDATE`, id).Scan(&currentOwner, &deleted, &suspended, &verified, &job.Generation); err != nil {
			return err
		}
		if (currentOwner == nil) != (owner == nil) || (owner != nil && *currentOwner != *owner) {
			return ErrStaleInstallationSync
		}
		if deleted != nil {
			return nil
		}
		switch action {
		case "deleted":
			if _, err := tx.Exec(ctx, `UPDATE repo SET disconnected_at=COALESCE(disconnected_at,clock_timestamp()) WHERE installation_id=$1`, id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE github_installation SET deleted_at=clock_timestamp(),workspace_id=NULL,ownership_verified_at=NULL,sync_generation=sync_generation+1,sync_error=NULL WHERE id=$1`, id)
			return err
		case "suspend", "unsuspend":
			check = true
			// Fence immediately, including while a current-state request retries.
			return tx.QueryRow(ctx, `UPDATE github_installation SET suspended_at=COALESCE(suspended_at,clock_timestamp()),sync_generation=sync_generation+1 WHERE id=$1 RETURNING sync_generation`, id).Scan(&job.Generation)
		default:
			if owner == nil || verified == nil || suspended != nil {
				return nil
			}
			return s.enqueueInstallationSyncTx(ctx, tx, *owner, id, false)
		}
	})
	return job, check, err
}

// ApplyInstallationState only clears suspension from an authoritative response
// whose captured generation and binding still match. No REST error deletes data.
func (s *Store) ApplyInstallationState(ctx context.Context, job InstallationSync, suspended bool) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if job.WorkspaceID != uuid.Nil {
			if err := lockWorkspaceTx(ctx, tx, job.WorkspaceID); err != nil {
				return err
			}
		}
		var owner *uuid.UUID
		var generation int64
		var deleted, verified *time.Time
		err := tx.QueryRow(ctx, `SELECT workspace_id,sync_generation,deleted_at,ownership_verified_at FROM github_installation WHERE id=$1 FOR UPDATE`, job.InstallationID).Scan(&owner, &generation, &deleted, &verified)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrStaleInstallationSync
		}
		if err != nil {
			return err
		}
		currentOwner := uuid.Nil
		if owner != nil {
			currentOwner = *owner
		}
		if generation != job.Generation || currentOwner != job.WorkspaceID || deleted != nil {
			return ErrStaleInstallationSync
		}
		if _, err := tx.Exec(ctx, `UPDATE github_installation SET suspended_at=CASE WHEN $2 THEN suspended_at ELSE NULL END,sync_error=NULL WHERE id=$1`, job.InstallationID, suspended); err != nil {
			return err
		}
		if !suspended && owner != nil && verified != nil {
			return s.enqueueInstallationSyncTx(ctx, tx, *owner, job.InstallationID, false)
		}
		return nil
	})
}

func (s *Store) InstallationStateCurrent(ctx context.Context, job InstallationSync) (bool, error) {
	var owner *uuid.UUID
	if job.WorkspaceID != uuid.Nil {
		owner = &job.WorkspaceID
	}
	var current bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_installation WHERE id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid AND sync_generation=$3 AND deleted_at IS NULL)`, job.InstallationID, owner, job.Generation).Scan(&current)
	return current, err
}

// ActiveRepo captures the binding generation before any provider fetch or
// evidence preparation. Historical reads continue to use RepoByGitHubID.
func (s *Store) ActiveRepo(ctx context.Context, githubID, installationID int64) (Repo, error) {
	repo, err := s.RepoByGitHubID(ctx, githubID)
	if err != nil {
		return repo, err
	}
	if installationID <= 0 || repo.InstallationID != installationID {
		return Repo{}, ErrNotFound
	}
	err = s.pool.QueryRow(ctx, `SELECT i.sync_generation FROM github_installation i JOIN repo r ON r.installation_id=i.id AND r.workspace_id=i.workspace_id WHERE r.id=$1 AND r.disconnected_at IS NULL AND i.ownership_verified_at IS NOT NULL AND i.suspended_at IS NULL AND i.deleted_at IS NULL`, repo.ID).Scan(&repo.SyncGeneration)
	return repo, mapErr(err)
}

// WithActiveRepo fences the entire evidence mutation, including links and
// activity. Workspace-first locks match lifecycle and installation binding.
func (s *Store) WithActiveRepo(ctx context.Context, repo Repo, write func(pgx.Tx) error) error {
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceTx(ctx, tx, repo.WorkspaceID); err != nil {
			return err
		}
		var id int64
		err := tx.QueryRow(ctx, `SELECT id FROM github_installation WHERE id=$1 AND workspace_id=$2 AND sync_generation=$3 AND ownership_verified_at IS NOT NULL AND suspended_at IS NULL AND deleted_at IS NULL FOR UPDATE`, repo.InstallationID, repo.WorkspaceID, repo.SyncGeneration).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrStaleInstallationSync
		}
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT github_id FROM repo WHERE id=$1 AND workspace_id=$2 AND installation_id=$3 AND disconnected_at IS NULL FOR UPDATE`, repo.ID, repo.WorkspaceID, repo.InstallationID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrStaleInstallationSync
		}
		if err != nil {
			return err
		}
		return write(tx)
	})
	if errors.Is(err, ErrStaleInstallationSync) {
		return nil
	}
	return err
}
