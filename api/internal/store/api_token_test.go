package store_test

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestAPITokenRoundTripStoresOnlyHashAndTracksUse(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	raw, err := f.Store.CreateAPIToken(ctx, f.User.ID, "CLI")
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(raw, "velvet_"))
	require.Len(t, strings.TrimPrefix(raw, "velvet_"), 64)

	var storedHash string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT token_hash FROM api_token`).Scan(&storedHash))
	require.Equal(t, store.HashToken(raw), storedHash)
	require.NotEqual(t, raw, storedHash)

	tokens, err := f.Store.ListAPITokens(ctx, f.User.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.Equal(t, "CLI", tokens[0].Name)
	require.NotZero(t, tokens[0].ID)
	require.False(t, tokens[0].CreatedAt.IsZero())
	require.Nil(t, tokens[0].LastUsedAt)

	user, err := f.Store.LookupAPIToken(ctx, raw)
	require.NoError(t, err)
	require.Equal(t, f.User.ID, user.ID)

	tokens, err = f.Store.ListAPITokens(ctx, f.User.ID)
	require.NoError(t, err)
	require.NotNil(t, tokens[0].LastUsedAt)
	firstUse := *tokens[0].LastUsedAt

	_, err = f.Store.LookupAPIToken(ctx, raw)
	require.NoError(t, err)
	tokens, err = f.Store.ListAPITokens(ctx, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, firstUse, *tokens[0].LastUsedAt, "recent token use must be throttled")

	_, err = f.Pool.Exec(ctx, `UPDATE api_token SET last_used_at=now()-interval '2 minutes' WHERE token_hash=$1`, storedHash)
	require.NoError(t, err)
	_, err = f.Store.LookupAPIToken(ctx, raw)
	require.NoError(t, err)
	tokens, err = f.Store.ListAPITokens(ctx, f.User.ID)
	require.NoError(t, err)
	require.True(t, tokens[0].LastUsedAt.After(firstUse))
}

func TestAPITokenDuplicateNamesAndLimitAreEnforcedAtomically(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	_, err := f.Store.CreateAPIToken(ctx, f.User.ID, "same")
	require.NoError(t, err)
	_, err = f.Store.CreateAPIToken(ctx, f.User.ID, "same")
	require.ErrorIs(t, err, store.ErrDuplicate)

	for i := 1; i < 20; i++ {
		_, err = f.Store.CreateAPIToken(ctx, f.User.ID, "token-"+time.Duration(i).String())
		require.NoError(t, err)
	}
	_, err = f.Store.CreateAPIToken(ctx, f.User.ID, "too-many")
	require.ErrorIs(t, err, store.ErrAPITokenLimit)
}

func TestDeleteAPITokenRevokesOnlyTheOwnerToken(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	raw, err := f.Store.CreateAPIToken(ctx, f.User.ID, "delete-me")
	require.NoError(t, err)
	tokens, err := f.Store.ListAPITokens(ctx, f.User.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)

	require.NoError(t, f.Store.DeleteAPIToken(ctx, f.User.ID, tokens[0].ID))
	_, err = f.Store.LookupAPIToken(ctx, raw)
	require.ErrorIs(t, err, store.ErrNotFound)
	err = f.Store.DeleteAPIToken(ctx, f.User.ID, tokens[0].ID)
	require.ErrorIs(t, err, store.ErrNotFound)
}
