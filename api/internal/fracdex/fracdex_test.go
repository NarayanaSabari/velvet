package fracdex_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/fracdex"
)

func TestBetweenProducesOrderedKeys(t *testing.T) {
	cases := []struct{ a, b string }{
		{"", ""},
		{"V", ""},
		{"", "V"},
		{"V", "W"},
		{"V0", "V1"},
	}
	for _, c := range cases {
		got, err := fracdex.Between(c.a, c.b)
		require.NoError(t, err, "Between(%q, %q)", c.a, c.b)
		if c.a != "" {
			require.Greater(t, got, c.a, "Between(%q, %q) = %q", c.a, c.b, got)
		}
		if c.b != "" {
			require.Less(t, got, c.b, "Between(%q, %q) = %q", c.a, c.b, got)
		}
	}
}

func TestRepeatedInsertionBetweenTheSamePairStaysOrdered(t *testing.T) {
	lo, hi := "V", "W"
	prev := lo
	for i := 0; i < 50; i++ {
		mid, err := fracdex.Between(prev, hi)
		require.NoError(t, err)
		require.Greater(t, mid, prev)
		require.Less(t, mid, hi)
		prev = mid
	}
}

func TestBetweenRejectsReversedArguments(t *testing.T) {
	_, err := fracdex.Between("W", "V")
	require.ErrorIs(t, err, fracdex.ErrOutOfOrder)
}
