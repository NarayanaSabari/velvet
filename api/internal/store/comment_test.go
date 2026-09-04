package store_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		body string
		want []string
	}{
		{"no mentions here", nil},
		{"hey @sabari take a look", []string{"sabari"}},
		{"@Sabari and @sabari are the same person", []string{"sabari"}},
		{"@one @two-dash @three", []string{"one", "two-dash", "three"}},
		{"email me at me@example.com", nil},
		{"`@notmention` in code", nil},
	}
	for _, c := range cases {
		require.Equal(t, c.want, store.ParseMentions(c.body), "body: %s", c.body)
	}
}
