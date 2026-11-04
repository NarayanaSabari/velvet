# internal

## Overview
Private Go packages shared by the `velvet` binary. They are not importable outside this module.

## Subdirectories & Boundaries
- client: [./client/README.md](./client/README.md) - HTTP client for one Velvet server, with no redirect following and a JSON error envelope.
- config: [./config/README.md](./config/README.md) - `velvet.yaml`, keychain or 0600 file credentials, and private directory bindings.

## Interface
- [./client/README.md](./client/README.md) - `client.Client`, `client.New`, `client.Error`, `client.StatusOf`.
- [./config/README.md](./config/README.md) - `config.Link`, `config.Find`, `config.Write`, `config.Keys`.

## Invariants
- None

## Side Effects
- None

## Verification
- Run: `go test ./internal/...` from `cli/`.
