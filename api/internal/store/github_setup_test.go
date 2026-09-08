package store_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// A second session or purpose cannot spend a state, and claiming removes the stored verifier.
func TestGitHubAuthorizationClaimAndProfileReceipt(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	state, challenge, err := f.Store.CreateGitHubLinkAuthorization(ctx, f.Token, f.User.ID)
	require.NoError(t, err)
	require.Len(t, state, 43)
	require.Len(t, challenge, 43)
	other, err := f.Store.CreateSession(ctx, f.User.ID, time.Hour)
	require.NoError(t, err)
	_, err = f.Store.ClaimGitHubAuthorization(ctx, state, other, f.User.ID, "link")
	require.ErrorIs(t, err, store.ErrNotFound)
	_, err = f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "installation")
	require.ErrorIs(t, err, store.ErrNotFound)
	a, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "link")
	require.NoError(t, err)
	require.Len(t, a.Verifier, 43)
	var verifier string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT verifier FROM github_authorization_state WHERE token_hash=$1`, store.HashToken(state)).Scan(&verifier))
	require.Empty(t, verifier)
	_, err = f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "link")
	require.ErrorIs(t, err, store.ErrNotFound)
	require.NoError(t, f.Store.CompleteGitHubLink(ctx, a, store.GitHubIdentity{ID: 42, Login: "new-owner"}))
	receipt, err := f.Store.GetGitHubAuthorization(ctx, state, f.Token, f.User.ID)
	require.NoError(t, err)
	require.True(t, receipt.Completed)
	user, err := f.Store.UserBySessionToken(ctx, f.Token)
	require.NoError(t, err)
	require.Equal(t, int64(42), *user.GitHubID)
	require.NoError(t, f.Store.UnlinkGitHub(ctx, f.Token, f.User.ID))
	user, err = f.Store.UserBySessionToken(ctx, f.Token)
	require.NoError(t, err)
	require.Nil(t, user.GitHubID)
	require.Nil(t, user.GitHubLogin)
}

func TestGitHubAuthorizationExpiryAfterLockWait(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	state, _, err := f.Store.CreateGitHubLinkAuthorization(ctx, f.Token, f.User.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `UPDATE github_authorization_state SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE token_hash=$1`, store.HashToken(state))
	require.NoError(t, err)
	tx, err := f.Pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `UPDATE github_authorization_state SET verifier=verifier WHERE token_hash=$1`, store.HashToken(state))
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		_, err := f.Store.ClaimGitHubAuthorization(context.Background(), state, f.Token, f.User.ID, "link")
		done <- err
	}()
	require.Eventually(t, func() bool {
		var n int
		err := f.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&n)
		return err == nil && n > 0
	}, time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		var expired bool
		err := f.Pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM github_authorization_state WHERE token_hash=$1`, store.HashToken(state)).Scan(&expired)
		return err == nil && expired
	}, time.Second, 10*time.Millisecond)
	require.NoError(t, tx.Rollback(ctx))
	require.ErrorIs(t, <-done, store.ErrNotFound)
}

func TestGitHubSetupCompletionWritesBothReceipts(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	setup, err := f.Store.CreateGitHubSetup(ctx, f.Token, f.User.ID, f.WorkspaceID)
	require.NoError(t, err)
	state, _, err := f.Store.StartGitHubInstallationAuthorization(ctx, setup, f.Token, f.User.ID, 99)
	require.NoError(t, err)
	a, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "installation")
	require.NoError(t, err)
	require.Equal(t, int64(99), a.CandidateInstallationID)
	require.NoError(t, f.Store.InTx(ctx, func(tx pgx.Tx) error {
		if err := store.LockGitHubInstallationAuthorizationTx(ctx, tx, a); err != nil {
			return err
		}
		return store.CompleteGitHubInstallationAuthorizationTx(ctx, tx, a)
	}))
	receipt, err := f.Store.GetGitHubAuthorization(ctx, state, f.Token, f.User.ID)
	require.NoError(t, err)
	require.True(t, receipt.Completed)
	var phase string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT phase FROM github_setup_state WHERE token_hash=$1`, store.HashToken(setup)).Scan(&phase))
	require.Equal(t, "completed", phase)
}

func TestGitHubAuthorizationConcurrentClaimsHaveOneWinner(t *testing.T) {
	f := testutil.NewFixture(t)
	state, _, err := f.Store.CreateGitHubLinkAuthorization(t.Context(), f.Token, f.User.ID)
	require.NoError(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.Store.ClaimGitHubAuthorization(context.Background(), state, f.Token, f.User.ID, "link")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	won := 0
	for err := range results {
		if err == nil {
			won++
		} else {
			require.ErrorIs(t, err, store.ErrNotFound)
		}
	}
	require.Equal(t, 1, won)
}

// A profile-row lock can outlive either the authorization or its session.
// Completion must roll back the identity update if either expired during that wait.
func TestGitHubLinkCompletionExpiryWhileWaitingForUser(t *testing.T) {
	for _, table := range []string{"github_authorization_state", "session"} {
		t.Run(table, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			state, _, err := f.Store.CreateGitHubLinkAuthorization(ctx, f.Token, f.User.ID)
			require.NoError(t, err)
			a, err := f.Store.ClaimGitHubAuthorization(ctx, state, f.Token, f.User.ID, "link")
			require.NoError(t, err)
			key, hash := "token_hash", store.HashToken(state)
			if table == "session" {
				key, hash = "id", store.HashToken(f.Token)
			}
			_, err = f.Pool.Exec(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE `+key+`=$1`, hash)
			require.NoError(t, err)
			tx, err := f.Pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, `UPDATE app_user SET name=name WHERE id=$1`, f.User.ID)
			require.NoError(t, err)
			done := make(chan error, 1)
			go func() {
				done <- f.Store.CompleteGitHubLink(context.Background(), a, store.GitHubIdentity{ID: 42, Login: "owner"})
			}()
			require.Eventually(t, func() bool {
				var n int
				err := f.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&n)
				return err == nil && n > 0
			}, time.Second, 10*time.Millisecond)
			require.Eventually(t, func() bool {
				var expired bool
				err := f.Pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM `+table+` WHERE `+key+`=$1`, hash).Scan(&expired)
				return err == nil && expired
			}, time.Second, 10*time.Millisecond)
			require.NoError(t, tx.Rollback(ctx))
			require.ErrorIs(t, <-done, store.ErrNotFound)
			var id int64
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT github_id FROM app_user WHERE id=$1`, f.User.ID).Scan(&id))
			require.Equal(t, *f.User.GitHubID, id)
		})
	}
}
