package store_test

import (
	"sync"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestConfirmLoginAcceptsInviteAndStoresHashedSession(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	i := createLoginTokenInvite(t, pool)
	token, err := st.IssueLoginToken(t.Context(), "invitee@example.com", "127.0.0.1", &i)
	require.NoError(t, err)
	result, err := st.ConfirmLogin(t.Context(), token)
	require.NoError(t, err)
	require.Equal(t, "/w/lab", result.Next)
	var hash string
	var workspaceID, lastWorkspaceID uuid.UUID
	var accepted, created, expires time.Time
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT s.id,s.last_workspace_id,s.created_at,s.expires_at,i.workspace_id,i.accepted_at FROM session s JOIN app_user u ON u.id=s.user_id JOIN invite i ON i.email=u.email WHERE i.id=$1`, i).Scan(&hash, &lastWorkspaceID, &created, &expires, &workspaceID, &accepted))
	require.Equal(t, store.HashToken(result.SessionToken), hash)
	require.Equal(t, workspaceID, lastWorkspaceID)
	require.WithinDuration(t, created.Add(30*24*time.Hour), expires, time.Second)
	_, err = st.UserBySessionToken(t.Context(), result.SessionToken)
	require.NoError(t, err)
}

func TestConfirmLoginExistingUserUsesDeterministicMembership(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(), `WITH w AS (INSERT INTO workspace(name,slug,created_at) VALUES ('Earlier','zzz',now()-interval '1 day') RETURNING id) INSERT INTO membership(workspace_id,user_id,role) SELECT id,$1,'member' FROM w`, f.User.ID)
	require.NoError(t, err)
	token, err := f.Store.IssueLoginToken(t.Context(), f.User.Email, "127.0.0.1", nil)
	require.NoError(t, err)
	result, err := f.Store.ConfirmLogin(t.Context(), token)
	require.NoError(t, err)
	require.Equal(t, "/w/zzz", result.Next)
	u, err := f.Store.UserBySessionToken(t.Context(), result.SessionToken)
	require.NoError(t, err)
	require.Equal(t, f.User.ID, u.ID)
}

func TestConfirmLoginConcurrentReplayCreatesOnlyOneSession(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	token, err := st.IssueLoginToken(t.Context(), "new@example.com", "127.0.0.1", nil)
	require.NoError(t, err)
	errs := make([]error, 8)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = st.ConfirmLogin(t.Context(), token) }()
	}
	wg.Wait()
	require.Equal(t, 1, countIssues(errs, nil))
	require.Equal(t, 7, countIssues(errs, store.ErrNotFound))
	var n int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM session`).Scan(&n))
	require.Equal(t, 1, n)
}

// A rolled-back competing confirmation must not preserve a pre-wait expiry check.
func TestConfirmLoginRechecksExpiryAfterTokenLockRollback(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	token, err := st.IssueLoginToken(ctx, "new@example.com", "127.0.0.1", nil)
	require.NoError(t, err)
	hash := store.HashToken(token)
	_, err = pool.Exec(ctx, `UPDATE login_token SET expires_at=clock_timestamp()+interval '10 seconds' WHERE token_hash=$1`, hash)
	require.NoError(t, err)
	holder, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer holder.Rollback(ctx)
	_, err = holder.Exec(ctx, `UPDATE login_token SET consumed_at=clock_timestamp() WHERE token_hash=$1`, hash)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { _, err := st.ConfirmLogin(ctx, token); done <- err }()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%login_token%')`).Scan(&waiting)
		return err == nil && waiting
	}, 10*time.Second, 10*time.Millisecond)
	var stillValid bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at>clock_timestamp() FROM login_token WHERE token_hash=$1`, hash).Scan(&stillValid))
	require.True(t, stillValid, "confirmation must begin waiting before expiry")
	require.Eventually(t, func() bool {
		var expired bool
		err := pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM login_token WHERE token_hash=$1`, hash).Scan(&expired)
		return err == nil && expired
	}, 15*time.Second, 10*time.Millisecond)
	require.NoError(t, holder.Rollback(ctx))
	require.ErrorIs(t, <-done, store.ErrNotFound)
	var users, sessions, consumed int
	require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM app_user), (SELECT count(*) FROM session), (SELECT count(*) FROM login_token WHERE consumed_at IS NOT NULL)`).Scan(&users, &sessions, &consumed))
	require.Zero(t, users)
	require.Zero(t, sessions)
	require.Zero(t, consumed)
}

func TestConfirmLoginSessionFailureRollsBackAllState(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	i := createLoginTokenInvite(t, pool)
	token, err := st.IssueLoginToken(t.Context(), "invitee@example.com", "127.0.0.1", &i)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `ALTER TABLE session ADD CONSTRAINT test_reject_session CHECK(false)`)
	require.NoError(t, err)
	_, err = st.ConfirmLogin(t.Context(), token)
	require.Error(t, err)
	var users, consumed, accepted, members int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM app_user WHERE email='invitee@example.com'), (SELECT count(*) FROM login_token WHERE consumed_at IS NOT NULL), (SELECT count(*) FROM invite WHERE accepted_at IS NOT NULL), (SELECT count(*) FROM membership)`).Scan(&users, &consumed, &accepted, &members))
	require.Zero(t, users)
	require.Zero(t, consumed)
	require.Zero(t, accepted)
	require.Zero(t, members)
}

// Revocation/deletion and expiry while waiting must never create a partial login.
func TestConfirmLoginRechecksAfterWorkspaceLockWait(t *testing.T) {
	for _, change := range []string{"expire_login", "expire_invite", "delete_invite"} {
		t.Run(change, func(t *testing.T) {
			pool := testutil.NewPostgres(t)
			st := store.New(pool)
			ctx := t.Context()
			i := createLoginTokenInvite(t, pool)
			token, err := st.IssueLoginToken(ctx, "invitee@example.com", "127.0.0.1", &i)
			require.NoError(t, err)
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			require.NoError(t, store.LockInviteWorkspaceTx(ctx, tx, i))
			done := make(chan error, 1)
			go func() { _, err := st.ConfirmLogin(ctx, token); done <- err }()
			require.Eventually(t, func() bool {
				var waiting bool
				err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
				return err == nil && waiting
			}, 10*time.Second, 10*time.Millisecond)
			switch change {
			case "expire_login":
				_, err = tx.Exec(ctx, `UPDATE login_token SET expires_at=clock_timestamp() WHERE invite_id=$1`, i)
			case "expire_invite":
				_, err = tx.Exec(ctx, `UPDATE invite SET expires_at=clock_timestamp() WHERE id=$1`, i)
			case "delete_invite":
				_, err = tx.Exec(ctx, `DELETE FROM invite WHERE id=$1`, i)
			}
			require.NoError(t, err)
			require.NoError(t, tx.Commit(ctx))
			require.ErrorIs(t, <-done, store.ErrNotFound)
			var users, sessions int
			require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM app_user WHERE email='invitee@example.com'),(SELECT count(*) FROM session)`).Scan(&users, &sessions))
			require.Zero(t, users)
			require.Zero(t, sessions)
		})
	}
}
