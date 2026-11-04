# linker

## Overview
Pure matcher that finds the issue keys a pull request refers to. No database access, so matching rules stay exhaustively testable.

## Interface
- `type Match struct { Key, Source string; Closing bool }`
- `func Find(prefix, branch, title, body string) []Match`

## Invariants
- Keys match `(?i)\b(PREFIX)-(\d+)\b`, so `ENG-1` never swallows the `2` of `ENG-12` and `strengthen` never matches `ENG`.
- Branch matches come before title and body matches.
- [Find](linker.go) normalizes keys to uppercase and emits each key once. Branch matches use source `"branch"`; title and body matches both use `"body"`.
- Closing-word detection applies only to title/body, using `(?i)\b(close[sd]?|fixe?[sd]?|resolve[sd]?)\s+$` before the key. A later closing match upgrades `Closing` while preserving the first source. Branch words never set `Closing`.

## Side Effects
- None.

## Verification
- Run: `cd api && go test ./internal/linker/...`
