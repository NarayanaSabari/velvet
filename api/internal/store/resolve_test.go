package store_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// A remote is whatever git happens to print, so every form git produces has to
// resolve to the same repository.
func TestParseRemoteAcceptsEveryFormGitProduces(t *testing.T) {
	for _, remote := range []string{
		"git@github.com:acme/widgets.git",
		"git@github.com:acme/widgets",
		"ssh://git@github.com/acme/widgets.git",
		"https://github.com/acme/widgets.git",
		"https://github.com/acme/widgets",
		"https://user:token@github.com/acme/widgets.git",
		"http://github.com/acme/widgets/",
		"acme/widgets",
		"  https://github.com/acme/widgets.git  ",
	} {
		owner, name, ok := store.ParseRemote(remote)
		require.True(t, ok, "%q must parse", remote)
		require.Equal(t, "acme", owner, remote)
		require.Equal(t, "widgets", name, remote)
	}
}

// Guessing at an unrecognised remote could send a work-log entry into the
// wrong client's organisation, so it must fail instead.
func TestParseRemoteRefusesWhatItCannotRead(t *testing.T) {
	for _, remote := range []string{
		"", "   ", "https://github.com/acme", "not a remote",
		"https://github.com/", "/acme/widgets/extra/path",
	} {
		_, _, ok := store.ParseRemote(remote)
		require.False(t, ok, "%q must not resolve", remote)
	}
}
