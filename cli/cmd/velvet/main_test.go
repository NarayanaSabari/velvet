package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// usageCommands are the commands --help lists.
func usageCommands(t *testing.T) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^  ([a-z][a-z-]*)\b`).FindAllStringSubmatch(usage, -1) {
		out[m[1]] = true
	}
	if len(out) < 10 {
		t.Fatalf("parsed only %d commands from usage", len(out))
	}
	return out
}

// Every command --help lists is dispatched, rather than reported unknown.
func TestUsageMatchesDispatch(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("VELVET_TOKEN", "")
	for cmd := range usageCommands(t) {
		if cmd == "init" || cmd == "update" {
			continue // would reach the network
		}
		err := run([]string{cmd}, io.Discard, io.Discard, strings.NewReader(""))
		if err != nil && strings.Contains(err.Error(), "unknown command") {
			t.Errorf("--help lists %q but run does not dispatch it", cmd)
		}
	}
	if err := run([]string{"nope"}, io.Discard, io.Discard, nil); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Errorf("an unknown command was accepted: %v", err)
	}
}

// The agent plugin's skills teach agents to run velvet commands by name. A
// skill naming a command the CLI lacks sends agents to a dead end, and a
// command no skill mentions is one agents never learn about.
func TestPluginSkillsNameOnlyRealCommands(t *testing.T) {
	commands := usageCommands(t)
	skills, err := filepath.Glob("../../../plugins/velvet/skills/*/SKILL.md")
	if err != nil || len(skills) == 0 {
		t.Fatalf("plugin skills not found: %v", err)
	}
	named := regexp.MustCompile("`velvet ([a-z][a-z-]*)")
	mentioned := map[string]bool{}
	for _, path := range skills {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(bytes.ToLower(body), []byte("mcp")) {
			t.Errorf("%s still mentions MCP", path)
		}
		for _, m := range named.FindAllSubmatch(body, -1) {
			cmd := string(m[1])
			mentioned[cmd] = true
			if !commands[cmd] {
				t.Errorf("%s names `velvet %s`, which the CLI does not have", path, cmd)
			}
		}
	}
	var missing []string
	for cmd := range commands {
		if !mentioned[cmd] {
			missing = append(missing, cmd)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("CLI commands no plugin skill mentions: %v", missing)
	}
}
