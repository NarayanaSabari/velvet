package api_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// The Claude Code and Codex plugins teach agents to call hosted MCP tools by
// name. A skill naming a tool the server does not expose would send agents to
// a dead end, so every tool a skill mentions must exist.
func TestPluginSkillsOnlyNameRealMCPTools(t *testing.T) {
	f := testutil.NewFixture(t)
	session := connectMCP(t, f, f.Slug, f.AgentToken("plugin check"))
	tools, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	exposed := map[string]bool{}
	for _, tool := range tools.Tools {
		exposed[tool.Name] = true
	}

	skills, err := filepath.Glob("../../../plugins/velvet/skills/*/SKILL.md")
	require.NoError(t, err)
	require.NotEmpty(t, skills, "plugin skills not found")

	toolName := regexp.MustCompile(`\bvelvet_[a-z_]+\b`)
	mentioned := map[string]bool{}
	for _, path := range skills {
		body, err := os.ReadFile(path)
		require.NoError(t, err)
		for _, name := range toolName.FindAllString(string(body), -1) {
			mentioned[name] = true
			require.True(t, exposed[name], "%s names %s, which the hosted MCP server does not expose", path, name)
		}
	}

	// Every exposed tool should be reachable from some skill, so new tools
	// get documented rather than silently ignored by agents.
	var undocumented []string
	for name := range exposed {
		if !mentioned[name] {
			undocumented = append(undocumented, name)
		}
	}
	sort.Strings(undocumented)
	require.Empty(t, undocumented, "hosted MCP tools no plugin skill mentions")
}
