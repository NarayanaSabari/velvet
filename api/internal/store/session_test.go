package store_test

import (
	"testing"
	"time"

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
