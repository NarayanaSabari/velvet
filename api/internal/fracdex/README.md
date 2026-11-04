# fracdex

## Overview
Fractional index keys for ordering rows without renumbering.

## Interface
- `func Between(a, b string) (string, error)`
- `func First() string` (returns `"V"`)
- `var ErrOutOfOrder`, `var ErrTooDeep`

## Invariants
- Keys use digits `0-9A-Za-z` and sort in byte order.
- `Between` returns a key strictly between `a` and `b`. Empty `a` means before everything and empty `b` means after everything.
- Nonempty `a` must sort before nonempty `b`; invalid ordering or any character outside the alphabet returns `ErrOutOfOrder`. Even ordered inputs can exhaust the 64-iteration generation bound and return `ErrTooDeep`. See [Between](fracdex.go).

## Side Effects
- None.

## Verification
- Run: `cd api && go test ./internal/fracdex/...`
