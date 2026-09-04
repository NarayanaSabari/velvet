package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestUpsertUserIsIdempotent(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	u1, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 42, Login: "sabari", Name: "Sabari", AvatarURL: "https://x/a.png"})
	require.NoError(t, err)

	u2, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 42, Login: "sabari-renamed", Name: "Sabari K", AvatarURL: "https://x/b.png"})
	require.NoError(t, err)

	require.Equal(t, u1.ID, u2.ID, "the same GitHub id must map to one user")
	require.Equal(t, "sabari-renamed", u2.GitHubLogin, "a renamed login must be picked up")
}

func TestBindMembershipClaimsInviteCaseInsensitively(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	_, err := pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, invited_login, role) VALUES ($1, 'Sabari', 'admin')`, wsID)
	require.NoError(t, err)

	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 7, Login: "sabari"})
	require.NoError(t, err)

	bound, err := st.BindMembership(ctx, u.ID, u.GitHubLogin)
	require.NoError(t, err)
	require.Equal(t, 1, bound)

	ms, err := st.MembershipsForUser(ctx, u.ID)
	require.NoError(t, err)
	require.Len(t, ms, 1)
	require.Equal(t, "admin", ms[0].Role)
}

func TestSessionRoundTripAndExpiry(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 9, Login: "dev"})
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
