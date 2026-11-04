# cmd

## Overview
Entry points for binaries built from the CLI module.

## Subdirectories & Boundaries
- velvet: [./velvet/README.md](./velvet/README.md) - the `velvet` binary, command dispatch, login, init, work, planning, admin, and self-update.

## Interface
- [./velvet/README.md](./velvet/README.md) - `package main` for the `velvet` binary.

## Invariants
- None

## Side Effects
- None

## Verification
- Run: `go test ./cmd/...` from `cli/`.
