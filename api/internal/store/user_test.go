package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestUpsertUserByEmailNormalizesAndPreservesLinkedIdentity(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	first, err := st.UpsertUserByEmail(ctx, " Member@Example.com ")
	require.NoError(t, err)
	require.Equal(t, "member@example.com", first.Email)
	require.Nil(t, first.GitHubID)
	require.Nil(t, first.GitHubLogin)

	_, err = pool.Exec(ctx, `
		UPDATE app_user SET github_id = 42, github_login = 'member-gh', name = 'Member'
		WHERE id = $1`, first.ID)
	require.NoError(t, err)

	second, err := st.UpsertUserByEmail(ctx, "MEMBER@example.COM")
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID)
	require.Equal(t, "member@example.com", second.Email)
	require.NotNil(t, second.GitHubID)
	require.NotNil(t, second.GitHubLogin)
	require.Equal(t, int64(42), *second.GitHubID)
	require.Equal(t, "member-gh", *second.GitHubLogin)
}

func TestSessionRoundTripAndExpiry(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	u, err := testutil.CreateLinkedUser(t, st, store.GitHubIdentity{ID: 9, Login: "dev"})
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, u.ID, time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := st.UserBySessionToken(ctx, token)
	require.NoError(t, err)
	require.Equal(t, u.ID, got.ID)

	expired, err := st.CreateSession(ctx, u.ID, -time.Minute)
	require.NoError(t, err)
	_, err = st.UserBySessionToken(ctx, expired)
	require.ErrorIs(t, err, store.ErrNotFound, "an expired session must not authenticate")

	require.NoError(t, st.DeleteSession(ctx, token))
	_, err = st.UserBySessionToken(ctx, token)
	require.ErrorIs(t, err, store.ErrNotFound)
}
