package linker_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/linker"
)

func TestFindMatchesBranchNames(t *testing.T) {
	cases := []struct{ branch, want string }{
		{"sabari/eng-142-fix-auth", "ENG-142"},
		{"ENG-7", "ENG-7"},
		{"feature/ENG-99-thing", "ENG-99"},
		{"eng-1", "ENG-1"},
	}
	for _, c := range cases {
		got := linker.Find("ENG", c.branch, "", "")
		require.Len(t, got, 1, "branch %q", c.branch)
		require.Equal(t, c.want, got[0].Key)
		require.Equal(t, "branch", got[0].Source)
		require.False(t, got[0].Closing, "a branch name never implies closing")
	}
}

func TestFindIgnoresLookalikeBranches(t *testing.T) {
	for _, branch := range []string{
		"main",
		"strengthen-auth",       // contains "eng" inside a word
		"sabari/engine-rewrite", // "engine", not a key
		"eng-",                  // no number
		"release/v1.2.3",
	} {
		require.Empty(t, linker.Find("ENG", branch, "", ""), "branch %q", branch)
	}
}

func TestClosingKeywordsAreDetected(t *testing.T) {
	for _, body := range []string{
		"closes ENG-7", "Closes ENG-7", "fixes ENG-7", "resolved ENG-7",
		"This closes ENG-7 finally.",
	} {
		got := linker.Find("ENG", "", "", body)
		require.Len(t, got, 1, "body %q", body)
		require.True(t, got[0].Closing, "body %q must be closing", body)
	}
}

func TestBareMentionIsNotClosing(t *testing.T) {
	got := linker.Find("ENG", "", "", "Related to ENG-7, see also the design doc.")
	require.Len(t, got, 1)
	require.Equal(t, "ENG-7", got[0].Key)
	require.False(t, got[0].Closing,
		"a bare mention links without implying the issue is finished")
}

func TestBranchMatchWinsOverBody(t *testing.T) {
	got := linker.Find("ENG", "sabari/eng-1-thing", "", "also mentions ENG-2")
	require.Len(t, got, 2)
	require.Equal(t, "ENG-1", got[0].Key)
	require.Equal(t, "branch", got[0].Source)
	require.Equal(t, "ENG-2", got[1].Key)
	require.Equal(t, "body", got[1].Source)
}

func TestOnePRCanCloseSeveralIssues(t *testing.T) {
	got := linker.Find("ENG", "", "", "closes ENG-1 and closes ENG-2")
	require.Len(t, got, 2)
	require.True(t, got[0].Closing)
	require.True(t, got[1].Closing)
}

func TestTheSameKeyIsNotDuplicated(t *testing.T) {
	got := linker.Find("ENG", "sabari/eng-1-thing", "ENG-1 in the title", "closes ENG-1")
	require.Len(t, got, 1)
	require.Equal(t, "ENG-1", got[0].Key)
	require.Equal(t, "branch", got[0].Source, "the first source found wins")
	require.True(t, got[0].Closing,
		"a closing keyword anywhere still marks the link closing")
}

func TestAdjacentNumbersDoNotBleed(t *testing.T) {
	got := linker.Find("ENG", "", "", "ENG-12 and ENG-1 are different issues")
	require.Len(t, got, 2)
	require.Equal(t, "ENG-12", got[0].Key)
	require.Equal(t, "ENG-1", got[1].Key)
}

func TestNoMatchReturnsNothing(t *testing.T) {
	require.Empty(t, linker.Find("ENG", "main", "Bump deps", "Routine dependency bump."))
}
