package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CLI sign-in follows the device authorization pattern. The CLI keeps a long
// random device secret and polls with it; the person types or follows a short
// user code in a browser where they are already signed in, picks one
// organisation and one project, and approves. The key is minted only when the
// CLI collects it, scoped to exactly that choice.
const (
	cliSessionTTL     = 10 * time.Minute
	cliDeviceBytes    = 32
	cliUserCodeLength = 8
	// No 0/O/1/I/L, so a code read off a terminal is hard to mistype.
	cliUserCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
)

var (
	// ErrCLISessionPending is the normal answer while the person has not
	// approved yet.
	ErrCLISessionPending = errors.New("authorization pending")
	// ErrCLISessionDenied reports a request the person explicitly refused.
	ErrCLISessionDenied = errors.New("authorization denied")
	// ErrCLISessionExpired reports a request that timed out or was already
	// collected. The CLI starts over.
	ErrCLISessionExpired = errors.New("authorization expired")
)

// CLISession is the browser-facing view of one pending `velvet init`.
type CLISession struct {
	ID         uuid.UUID `json:"id"`
	UserCode   string    `json:"user_code"`
	ClientName string    `json:"client_name"`
	Status     string    `json:"status"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// CLIGrant is what the CLI receives once, when it collects an approval.
type CLIGrant struct {
	Token         string `json:"token"`
	WorkspaceSlug string `json:"workspace_slug"`
	WorkspaceName string `json:"workspace_name"`
	IssuePrefix   string `json:"issue_prefix"`
	ProjectKey    string `json:"project_key"`
	ProjectName   string `json:"project_name"`
	Role          string `json:"role"`
}

// NormalizeUserCode accepts the code however a person typed it: any case,
// with or without the separating hyphen or spaces.
func NormalizeUserCode(code string) string {
	code = strings.ToUpper(code)
	var b strings.Builder
	for _, r := range code {
		if strings.ContainsRune(cliUserCodeAlphabet, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// FormatUserCode shows a code as two groups of four, the way it is displayed.
func FormatUserCode(code string) string {
	if len(code) != cliUserCodeLength {
		return code
	}
	return code[:4] + "-" + code[4:]
}

func newUserCode() (string, error) {
	raw := make([]byte, cliUserCodeLength)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	out := make([]byte, cliUserCodeLength)
	for i, b := range raw {
		out[i] = cliUserCodeAlphabet[int(b)%len(cliUserCodeAlphabet)]
	}
	return string(out), nil
}

// CreateCLISession starts a sign-in and returns the device secret, which only
// the CLI ever holds, and the session with its user code.
func (s *Store) CreateCLISession(ctx context.Context, clientName string) (string, CLISession, error) {
	clientName = strings.TrimSpace(clientName)
	if clientName == "" || len(clientName) > 100 {
		clientName = "velvet CLI"
	}
	raw := make([]byte, cliDeviceBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", CLISession{}, err
	}
	device := "velvetdev_" + hex.EncodeToString(raw)

	// Expired rows are only ever read to refuse them, so clear them here
	// rather than running a separate sweeper.
	if _, err := s.pool.Exec(ctx, `DELETE FROM cli_session WHERE expires_at < now() - interval '1 hour'`); err != nil {
		return "", CLISession{}, err
	}

	for attempt := 0; attempt < 5; attempt++ {
		code, err := newUserCode()
		if err != nil {
			return "", CLISession{}, err
		}
		var out CLISession
		err = s.pool.QueryRow(ctx, `
			INSERT INTO cli_session (device_hash, user_code, client_name, expires_at)
			VALUES ($1, $2, $3, now() + $4::interval)
			RETURNING id, user_code, client_name, status, expires_at`,
			HashToken(device), code, clientName, cliSessionTTL.String()).
			Scan(&out.ID, &out.UserCode, &out.ClientName, &out.Status, &out.ExpiresAt)
		if errors.Is(mapErr(err), ErrDuplicate) {
			continue
		}
		if err != nil {
			return "", CLISession{}, err
		}
		return device, out, nil
	}
	return "", CLISession{}, errors.New("could not allocate a user code")
}

// CLISessionByCode returns a pending session for the approval page. Anything
// not pending, or past its expiry, reads as not found so a stale code can
// never be approved.
func (s *Store) CLISessionByCode(ctx context.Context, code string) (CLISession, error) {
	var out CLISession
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_code, client_name, status, expires_at
		FROM cli_session
		WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`,
		NormalizeUserCode(code)).
		Scan(&out.ID, &out.UserCode, &out.ClientName, &out.Status, &out.ExpiresAt)
	return out, mapErr(err)
}

// ApproveCLISession records which organisation and project the key will be
// bound to. The approver must be a writer in that organisation, and the
// project must belong to it; both are re-checked under the session row lock.
func (s *Store) ApproveCLISession(ctx context.Context, code string, approverID, workspaceID, projectID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT id FROM cli_session
			WHERE user_code = $1 AND status = 'pending' AND expires_at > now()
			FOR UPDATE`, NormalizeUserCode(code)).Scan(&id)
		if err != nil {
			return mapErr(err)
		}
		var role string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM membership WHERE workspace_id = $1 AND user_id = $2`,
			workspaceID, approverID).Scan(&role); err != nil {
			return mapErr(err)
		}
		if role != "admin" && role != "member" {
			return ErrForbidden
		}
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2)`,
			projectID, workspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrForeignReference
		}
		_, err = tx.Exec(ctx, `
			UPDATE cli_session
			SET status = 'approved', approved_by = $2, workspace_id = $3, project_id = $4
			WHERE id = $1`, id, approverID, workspaceID, projectID)
		return err
	})
}

// DenyCLISession refuses a pending sign-in. The CLI stops polling on the next
// answer.
func (s *Store) DenyCLISession(ctx context.Context, code string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE cli_session SET status = 'denied'
		WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`, NormalizeUserCode(code))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CollectCLISession is the CLI's poll. Once approved, the first poll mints
// the scoped key and marks the session collected, in one transaction, so the
// key is handed out exactly once and is never stored in raw form.
func (s *Store) CollectCLISession(ctx context.Context, device string) (CLIGrant, error) {
	var grant CLIGrant
	var outcome error
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var (
			id                     uuid.UUID
			status, clientName     string
			expired                bool
			approver               *uuid.UUID
			workspaceID, projectID *uuid.UUID
		)
		err := tx.QueryRow(ctx, `
			SELECT id, status, client_name, expires_at <= now(), approved_by, workspace_id, project_id
			FROM cli_session WHERE device_hash = $1 FOR UPDATE`, HashToken(device)).
			Scan(&id, &status, &clientName, &expired, &approver, &workspaceID, &projectID)
		if err != nil {
			if errors.Is(mapErr(err), ErrNotFound) {
				return ErrCLISessionExpired
			}
			return err
		}
		switch {
		case status == "denied":
			return ErrCLISessionDenied
		case status == "collected" || expired:
			return ErrCLISessionExpired
		case status == "pending":
			return ErrCLISessionPending
		}

		// Re-check at collection: the approver may have lost access, or the
		// project may have moved, since they clicked approve.
		var role string
		err = tx.QueryRow(ctx, `
			SELECT m.role, w.slug, w.name, w.issue_prefix, p.key, p.name
			FROM membership m
			JOIN workspace w ON w.id = m.workspace_id
			JOIN project p ON p.id = $3 AND p.workspace_id = w.id
			WHERE m.workspace_id = $1 AND m.user_id = $2`,
			workspaceID, approver, projectID).
			Scan(&role, &grant.WorkspaceSlug, &grant.WorkspaceName, &grant.IssuePrefix, &grant.ProjectKey, &grant.ProjectName)
		if err != nil || (role != "admin" && role != "member") {
			// Commit the refusal so later polls stop immediately; the outcome
			// is reported after the transaction rather than rolling it back.
			outcome = ErrCLISessionDenied
			_, markErr := tx.Exec(ctx, `UPDATE cli_session SET status = 'denied' WHERE id = $1`, id)
			return markErr
		}
		grant.Role = role

		name := clientName + " · " + grant.WorkspaceSlug + "/" + grant.ProjectKey + " · " + id.String()[:8]
		token, tokenID, err := createAPITokenTx(ctx, tx, *approver, name,
			TokenScope{WorkspaceID: workspaceID, ProjectID: projectID})
		if err != nil {
			return err
		}
		grant.Token = token
		_, err = tx.Exec(ctx,
			`UPDATE cli_session SET status = 'collected', api_token_id = $2 WHERE id = $1`, id, tokenID)
		return err
	})
	if err != nil {
		return CLIGrant{}, err
	}
	if outcome != nil {
		return CLIGrant{}, outcome
	}
	return grant, nil
}
