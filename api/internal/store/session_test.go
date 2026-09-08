package store_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestDeleteExpiredSessionsPreservesLiveSessions(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := t.Context()
	u, err := testutil.CreateLinkedUser(t, st, store.GitHubIdentity{ID: 91, Login: "session-cleanup"})
	require.NoError(t, err)

	live, err := st.CreateSession(ctx, u.ID, time.Hour)
	require.NoError(t, err)
	expired, err := st.CreateSession(ctx, u.ID, -time.Minute)
	require.NoError(t, err)

	deleted, err := st.DeleteExpiredSessions(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)
	_, err = st.UserBySessionToken(ctx, live)
	require.NoError(t, err)
	_, err = st.UserBySessionToken(ctx, expired)
	require.ErrorIs(t, err, store.ErrNotFound)
}

// Maintenance must not reset counters or cascade from an expired setup into a live authorization.
func TestCleanupExpiredAuthenticationPreservesLiveRecordsAndRecentCounters(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	_, err := f.Pool.Exec(ctx, `INSERT INTO login_token(email,token_hash,request_ip,created_at,expires_at) VALUES
	('old@example.com','old','127.0.0.1',now()-interval '1 hour',now()-interval '30 minutes'),
	('recent@example.com','recent','127.0.0.1',now()-interval '1 minute',now()-interval '1 second'),
	('live@example.com','live','127.0.0.1',now()-interval '1 hour',now()+interval '1 hour')`)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `INSERT INTO github_setup_state(token_hash,workspace_id,user_id,expires_at,session_id) VALUES
	('dead-setup',$1,$2,now()-interval '1 hour',$3),
	('parent-setup',$1,$2,now()-interval '1 hour',$3),
	('live-setup',$1,$2,now()+interval '1 hour',$3)`, f.WorkspaceID, f.User.ID, store.HashToken(f.Token))
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,setup_token_hash,verifier,expires_at) VALUES
	('dead-auth',$1,$2,'installation','dead-setup','test-verifier',now()-interval '1 hour'),
	('live-auth',$1,$2,'installation','parent-setup','test-verifier',now()+interval '1 hour')`, store.HashToken(f.Token), f.User.ID)
	require.NoError(t, err)
	require.NoError(t, f.Store.CleanupExpiredAuthentication(ctx))
	var loginHashes, setupHashes, authHashes []string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT array_agg(token_hash ORDER BY token_hash) FROM login_token`).Scan(&loginHashes))
	require.Equal(t, []string{"live", "recent"}, loginHashes)
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT array_agg(token_hash ORDER BY token_hash) FROM github_setup_state`).Scan(&setupHashes))
	require.Equal(t, []string{"live-setup", "parent-setup"}, setupHashes)
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT array_agg(token_hash ORDER BY token_hash) FROM github_authorization_state`).Scan(&authHashes))
	require.Equal(t, []string{"live-auth"}, authHashes)
}

func TestCleanupExpiredAuthenticationBoundsEachBatch(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO login_token(email,token_hash,request_ip,created_at,expires_at) SELECT 'old@example.com','token-'||n,'127.0.0.1',now()-interval '1 hour',now()-interval '30 minutes' FROM generate_series(1,1001) n`)
	require.NoError(t, err)
	require.NoError(t, f.Store.CleanupExpiredAuthentication(t.Context()))
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&n))
	require.Equal(t, 1, n)
}

// A child committed after cleanup's statement snapshot must not be cascaded away.
func TestCleanupExpiredAuthenticationPreservesConcurrentlyCreatedAuthorization(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	_, err := f.Pool.Exec(ctx, `INSERT INTO github_setup_state(token_hash,workspace_id,user_id,expires_at,session_id)
	VALUES ('parent-setup',$1,$2,now()-interval '1 hour',$3);
	`, f.WorkspaceID, f.User.ID, store.HashToken(f.Token))
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `CREATE FUNCTION pause_setup_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN PERFORM pg_advisory_xact_lock(918237); RETURN NULL; END $$;
	CREATE TRIGGER pause_setup_cleanup BEFORE DELETE ON github_setup_state FOR EACH STATEMENT EXECUTE FUNCTION pause_setup_cleanup()`)
	require.NoError(t, err)
	gate, err := f.Pool.Begin(ctx)
	require.NoError(t, err)
	defer gate.Rollback(ctx)
	_, err = gate.Exec(ctx, `SELECT pg_advisory_xact_lock(918237)`)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- f.Store.CleanupExpiredAuthentication(ctx) }()
	require.Eventually(t, func() bool {
		var waiting bool
		err := f.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'DELETE FROM github_setup_state%')`).Scan(&waiting)
		return err == nil && waiting
	}, time.Second, 10*time.Millisecond)
	insertDone := make(chan error, 1)
	go func() {
		_, err := f.Pool.Exec(ctx, `INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,setup_token_hash,verifier,expires_at)
		VALUES ('live-auth',$1,$2,'installation','parent-setup','test-verifier',now()+interval '1 hour')`, store.HashToken(f.Token), f.User.ID)
		insertDone <- err
	}()
	// Continue once creation commits or waits for cleanup's parent lock.
	require.Eventually(t, func() bool {
		var waiting bool
		err := f.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO github_authorization_state%')`).Scan(&waiting)
		return len(insertDone) != 0 || err == nil && waiting
	}, time.Second, 10*time.Millisecond)
	require.NoError(t, gate.Commit(ctx))
	require.NoError(t, <-done)
	insertErr := <-insertDone
	if insertErr != nil {
		// Cleanup may win the lock, making creation fail instead of losing a
		// successfully issued authorization behind the caller's back.
		var pgErr *pgconn.PgError
		require.ErrorAs(t, insertErr, &pgErr)
		require.Equal(t, "23503", pgErr.Code)
		return
	}
	var n int
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT count(*) FROM github_authorization_state WHERE token_hash='live-auth'`).Scan(&n))
	require.Equal(t, 1, n)
}
