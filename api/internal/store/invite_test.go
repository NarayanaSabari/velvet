package store_test

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestInviteAcceptance(t *testing.T) {
	for _, mode := range []string{"id", "token", "legacy email", "existing admin", "existing viewer", "wrong email", "expired", "revoked"} {
		t.Run(mode, func(t *testing.T) {
			pool := testutil.NewPostgres(t)
			st := store.New(pool)
			ctx := t.Context()
			var ws uuid.UUID
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Lab','lab') RETURNING id`).Scan(&ws))
			actor, err := st.UpsertUserByEmail(ctx, "actor@example.com")
			require.NoError(t, err)
			user, err := st.UpsertUserByEmail(ctx, " Person@Example.com ")
			require.NoError(t, err)
			invite, token, err := st.CreateInvite(ctx, ws, actor.ID, " PERSON@EXAMPLE.COM ", "member")
			require.NoError(t, err)
			preview, err := st.PreviewInviteToken(ctx, token)
			require.NoError(t, err)
			require.Equal(t, invite.ID, preview.ID)
			data, err := json.Marshal(preview)
			require.NoError(t, err)
			require.NotContains(t, string(data), "token")
			require.NotContains(t, string(data), store.HashToken(token))
			invites, err := st.ListMyInvites(ctx, user.ID)
			require.NoError(t, err)
			require.Len(t, invites, 1)
			wantRole := "member"
			switch mode {
			case "legacy email":
				_, err = pool.Exec(ctx, `UPDATE invite SET email=' Person@Example.com ' WHERE id=$1`, invite.ID)
				require.NoError(t, err)
			case "existing admin", "existing viewer":
				wantRole = mode[len("existing "):]
				_, err = pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES ($1,$2,$3::membership_role)`, ws, user.ID, wantRole)
				require.NoError(t, err)
			case "wrong email":
				user = actor
			case "expired":
				_, err = pool.Exec(ctx, `UPDATE invite SET expires_at=now()-interval '1 second' WHERE id=$1`, invite.ID)
				require.NoError(t, err)
			case "revoked":
				require.NoError(t, st.RevokeInvite(ctx, ws, invite.ID, actor.ID))
			}
			var m store.Membership
			if mode == "token" {
				m, err = st.AcceptInviteToken(ctx, token, user.ID)
			} else {
				m, err = st.AcceptMyInvite(ctx, invite.ID, user.ID)
			}
			if mode == "wrong email" || mode == "expired" || mode == "revoked" {
				require.Error(t, err)
				memberships, e := st.MembershipsForUser(ctx, user.ID)
				require.NoError(t, e)
				require.Empty(t, memberships)
				return
			}
			require.NoError(t, err)
			require.Equal(t, wantRole, m.Role)
			require.Equal(t, ws, m.WorkspaceID)
			_, err = st.AcceptMyInvite(ctx, invite.ID, user.ID)
			require.ErrorIs(t, err, store.ErrNotFound)
			invites, err = st.ListMyInvites(ctx, user.ID)
			require.NoError(t, err)
			require.Empty(t, invites)
			var n int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM activity WHERE verb='accepted_invite' AND actor_id=$1`, user.ID).Scan(&n))
			require.Equal(t, 1, n)
		})
	}
}

func TestInviteExpiryIsCheckedAfterWaitingForWorkspaceLock(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	var ws uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Lab','lab') RETURNING id`).Scan(&ws))
	user, err := st.UpsertUserByEmail(ctx, "person@example.com")
	require.NoError(t, err)
	invite, _, err := st.CreateInvite(ctx, ws, user.ID, user.Email, "member")
	require.NoError(t, err)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	require.NoError(t, store.LockInviteWorkspaceTx(ctx, tx, invite.ID))
	done := make(chan error, 1)
	go func() { _, err := st.AcceptMyInvite(ctx, invite.ID, user.ID); done <- err }()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspace%')`).Scan(&waiting)
		return err == nil && waiting
	}, time.Second, 10*time.Millisecond)
	_, err = tx.Exec(ctx, `UPDATE invite SET expires_at=clock_timestamp() WHERE id=$1`, invite.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	require.ErrorIs(t, <-done, store.ErrNotFound)
}

func TestReplaceInviteInvalidatesOldInviteAndLoginTokens(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	var ws uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Lab','lab') RETURNING id`).Scan(&ws))
	actor, err := st.UpsertUserByEmail(ctx, "actor@example.com")
	require.NoError(t, err)
	first, oldToken, err := st.CreateInvite(ctx, ws, actor.ID, "person@example.com", "member")
	require.NoError(t, err)
	login, err := st.IssueLoginToken(ctx, first.Email, "192.0.2.1", &first.ID)
	require.NoError(t, err)
	next, newToken, err := st.ReplaceInvite(ctx, ws, first.ID, actor.ID, "viewer")
	require.NoError(t, err)
	require.NotEqual(t, first.ID, next.ID)
	require.NotEqual(t, oldToken, newToken)
	_, err = st.PreviewInviteToken(ctx, oldToken)
	require.ErrorIs(t, err, store.ErrNotFound)
	var consumed *time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT consumed_at FROM login_token WHERE token_hash=$1`, store.HashToken(login)).Scan(&consumed))
	require.NotNil(t, consumed)
	list, err := st.ListWorkspaceInvites(ctx, ws)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, next.ID, list[0].ID)
	_, _, err = st.ReplaceInvite(ctx, uuid.New(), next.ID, actor.ID, "admin")
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestConcurrentInviteAcceptanceIsSingleUse(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	var ws uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Lab','lab') RETURNING id`).Scan(&ws))
	user, err := st.UpsertUserByEmail(ctx, "person@example.com")
	require.NoError(t, err)
	invite, _, err := st.CreateInvite(ctx, ws, user.ID, user.Email, "member")
	require.NoError(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	start := make(chan struct{})
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; _, err := st.AcceptMyInvite(ctx, invite.ID, user.ID); results <- err }()
	}
	close(start)
	wg.Wait()
	close(results)
	var success int
	for err := range results {
		if err == nil {
			success++
		} else {
			require.ErrorIs(t, err, store.ErrNotFound)
		}
	}
	require.Equal(t, 1, success)
	ms, err := st.MembershipsForUser(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, ms, 1)
}

func TestDeletingInvitePreservesLoginRateLimitsAndInvalidatesTokens(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()
	var ws uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace(name,slug) VALUES ('Lab','lab') RETURNING id`).Scan(&ws))
	user, err := st.UpsertUserByEmail(ctx, "person@example.com")
	require.NoError(t, err)
	invite, _, err := st.CreateInvite(ctx, ws, user.ID, user.Email, "member")
	require.NoError(t, err)
	for range 5 {
		_, err = st.IssueLoginToken(ctx, user.Email, "192.0.2.1", &invite.ID)
		require.NoError(t, err)
	}
	for n := range 15 {
		_, err = st.IssueLoginToken(ctx, fmt.Sprintf("other%d@example.com", n), "192.0.2.1", nil)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, ws)
	require.NoError(t, err)
	var total, consumed int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*),count(consumed_at) FROM login_token`).Scan(&total, &consumed))
	require.Equal(t, 20, total)
	require.Equal(t, 5, consumed)
	_, err = st.IssueLoginToken(ctx, user.Email, "192.0.2.2", nil)
	require.ErrorIs(t, err, store.ErrRateLimited)
	_, err = st.IssueLoginToken(ctx, "different@example.com", "192.0.2.1", nil)
	require.ErrorIs(t, err, store.ErrRateLimited)
}
