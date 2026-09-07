package store_test

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// This catches an issuance path that stores a replayable token or turns an
// unconfirmed address into an app user.
func TestIssueLoginTokenStoresOnlyHashWithoutCreatingUser(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	token, err := st.IssueLoginToken(ctx, " Member@Example.COM ", "127.0.0.1", nil)
	require.NoError(t, err)
	raw, err := base64.RawURLEncoding.DecodeString(token)
	require.NoError(t, err)
	require.Len(t, raw, 32)

	var email, tokenHash, requestIP string
	var createdAt, expiresAt time.Time
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT email, token_hash, request_ip::text, created_at, expires_at
		FROM login_token`).Scan(&email, &tokenHash, &requestIP, &createdAt, &expiresAt))
	require.Equal(t, "member@example.com", email)
	require.Equal(t, store.HashToken(token), tokenHash)
	require.NotEqual(t, token, tokenHash)
	require.Equal(t, "127.0.0.1", requestIP)
	require.WithinDuration(t, createdAt.Add(15*time.Minute), expiresAt, time.Second)

	var users int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM app_user WHERE email = $1`, email).Scan(&users))
	require.Zero(t, users)
}

// This catches accepting RFC display names or a comma-separated address list
// where the sign-in endpoint requires exactly one mailbox.
func TestIssueLoginTokenRejectsNonMailboxEmail(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))

	for _, email := range []string{
		"Member <member@example.com>",
		"one@example.com, two@example.com",
		"not-an-email",
	} {
		t.Run(email, func(t *testing.T) {
			_, err := st.IssueLoginToken(t.Context(), email, "127.0.0.1", nil)
			require.ErrorIs(t, err, store.ErrInvalidEmail)
		})
	}
}

// This catches separate rate-limit buckets for equivalent presentation forms
// of the same email and IPv6 address.
func TestIssueLoginTokenNormalizesEmailAndIP(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)

	_, err := st.IssueLoginToken(t.Context(), " Member@Example.COM ", "2001:0DB8:0:0:0:0:0:1", nil)
	require.NoError(t, err)
	_, err = st.IssueLoginToken(t.Context(), "mapped@example.com", "::ffff:127.0.0.1", nil)
	require.NoError(t, err)

	var email, requestIP string
	require.NoError(t, pool.QueryRow(t.Context(), `
		SELECT email, request_ip::text FROM login_token WHERE email = 'member@example.com'`).Scan(&email, &requestIP))
	require.Equal(t, "member@example.com", email)
	require.Equal(t, "2001:db8::1", requestIP)
	require.NoError(t, pool.QueryRow(t.Context(), `
		SELECT email, request_ip::text FROM login_token WHERE email = 'mapped@example.com'`).Scan(&email, &requestIP))
	require.Equal(t, "mapped@example.com", email)
	require.Equal(t, "127.0.0.1", requestIP)
}

// This catches a race between count and insert that lets concurrent requests
// issue more than the per-address limit.
func TestIssueLoginTokenLimitsConcurrentRequestsPerEmail(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := t.Context()

	results := issueConcurrently(30, func(i int) error {
		_, err := st.IssueLoginToken(ctx, "member@example.com", fmt.Sprintf("127.0.0.%d", i+1), nil)
		return err
	})
	require.Equal(t, 5, countIssues(results, nil))
	require.Equal(t, 25, countIssues(results, store.ErrRateLimited))
}

// This catches a race between count and insert that lets concurrent requests
// issue more than the shared-source-address limit.
func TestIssueLoginTokenLimitsConcurrentRequestsPerIP(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := t.Context()

	results := issueConcurrently(30, func(i int) error {
		_, err := st.IssueLoginToken(ctx, fmt.Sprintf("member-%d@example.com", i), "127.0.0.1", nil)
		return err
	})
	require.Equal(t, 20, countIssues(results, nil))
	require.Equal(t, 10, countIssues(results, store.ErrRateLimited))
}

// This catches a rate-limit query that excludes rows originating from an
// invitation, allowing those requests to bypass the address limit.
func TestIssueLoginTokenCountsInviteOriginatedRequests(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	inviteID := createLoginTokenInvite(t, pool)

	for range 5 {
		_, err := st.IssueLoginToken(ctx, "invitee@example.com", "127.0.0.1", &inviteID)
		require.NoError(t, err)
	}
	_, err := st.IssueLoginToken(ctx, "invitee@example.com", "127.0.0.2", nil)
	require.ErrorIs(t, err, store.ErrRateLimited)
}

func createLoginTokenInvite(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	ctx := t.Context()
	var workspaceID, inviterID, inviteID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		WITH workspace AS (
			INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id
		), inviter AS (
			INSERT INTO app_user (email) VALUES ('inviter@example.com') RETURNING id
		)
		INSERT INTO invite (workspace_id, email, role, token_hash, invited_by, expires_at)
		SELECT workspace.id, 'invitee@example.com', 'member', 'invite-token', inviter.id,
			now() + interval '7 days'
		FROM workspace, inviter
		RETURNING id, workspace_id, invited_by`).Scan(&inviteID, &workspaceID, &inviterID))
	return inviteID
}

// This catches a boundary comparison that treats a token created exactly
// fifteen minutes ago as still rate-limitable.
func TestIssueLoginTokenExcludesRequestsAtExpiryWindowBoundary(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	_, err := pool.Exec(ctx, `
		INSERT INTO login_token (email, token_hash, request_ip, created_at, expires_at)
		VALUES ('member@example.com', 'expired-window-token', '127.0.0.1',
			now() - interval '15 minutes', now())`)
	require.NoError(t, err)
	for range 5 {
		_, err := st.IssueLoginToken(ctx, "member@example.com", "127.0.0.2", nil)
		require.NoError(t, err)
	}
	_, err = st.IssueLoginToken(ctx, "member@example.com", "127.0.0.3", nil)
	require.ErrorIs(t, err, store.ErrRateLimited)
}

func issueConcurrently(n int, issue func(int) error) []error {
	results := make([]error, n)
	var group sync.WaitGroup
	group.Add(n)
	for i := range n {
		go func() {
			defer group.Done()
			results[i] = issue(i)
		}()
	}
	group.Wait()
	return results
}

func countIssues(results []error, want error) int {
	count := 0
	for _, err := range results {
		if errors.Is(err, want) {
			count++
		}
	}
	return count
}
