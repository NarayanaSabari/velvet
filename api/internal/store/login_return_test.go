package store_test

import (
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/stretchr/testify/require"
)

func TestLoginReturnToOnlyAllowsCLIConsent(t *testing.T) {
	for _, path := range []string{"", "/cli/approve?code=ABCD-EFGH"} {
		require.True(t, store.ValidLoginReturnTo(path), path)
	}
	for _, path := range []string{"//evil.example", "/\\evil.example", "https://evil.example", "/cli/approve?code=ABCD-EFGH\n", "/cli/approve?code=ABCD-EFGH&x=y", "/cli/approve?code=ABCD-EFGH#x", "/cli/approve?code=0000-1111"} {
		require.False(t, store.ValidLoginReturnTo(path), path)
	}
}
