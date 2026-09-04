// Package linker finds the issue keys a pull request refers to. It is pure so
// that the matching rules, which are the part users notice when they are
// wrong, can be tested exhaustively without a database.
package linker

import (
	"fmt"
	"regexp"
	"strings"
)

type Match struct {
	Key     string `json:"key"`
	Source  string `json:"source"`
	Closing bool   `json:"closing"`
}

var closingWords = regexp.MustCompile(
	`(?i)\b(close[sd]?|fixe?[sd]?|resolve[sd]?)\s+$`)

// Find returns every distinct issue key referenced by a pull request. Branch
// matches come first because a branch name is deliberate, whereas prose may
// mention an issue in passing.
func Find(prefix, branch, title, body string) []Match {
	// \b around the whole token stops "strengthen" matching prefix ENG and
	// stops ENG-1 swallowing the 2 of ENG-12.
	keyRe := regexp.MustCompile(
		fmt.Sprintf(`(?i)\b(%s)-(\d+)\b`, regexp.QuoteMeta(prefix)))

	var out []Match
	index := map[string]int{}

	add := func(key, source string, closing bool) {
		key = strings.ToUpper(key)
		if i, seen := index[key]; seen {
			// A closing keyword anywhere wins, but the first source stands.
			if closing {
				out[i].Closing = true
			}
			return
		}
		index[key] = len(out)
		out = append(out, Match{Key: key, Source: source, Closing: closing})
	}

	for _, m := range keyRe.FindAllStringIndex(branch, -1) {
		add(branch[m[0]:m[1]], "branch", false)
	}

	for _, text := range []string{title, body} {
		for _, m := range keyRe.FindAllStringIndex(text, -1) {
			closing := closingWords.MatchString(text[:m[0]])
			add(text[m[0]:m[1]], "body", closing)
		}
	}
	return out
}
