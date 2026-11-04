# velvet command

## Overview
`package main` for the `velvet` binary. It parses commands, resolves credentials through `internal/config`, and calls the API through `internal/client`. See [../../README.md](../../README.md) for the full user-facing command list.

## Interface
- `main.go:main`, `run` dispatch on the first argument (`admin`, `init`, `login`, `whoami`/`where`/`me`/`logout`, `key-from-branch`, `update`, `log`, `attach`, `recap`, `issues`, `issue`, `new`, `status`, `sprints`, `milestones`, `upload-image`, then ticket, planning, and project-view commands).
- `main.go:env`, `loadEnv`, `apiError`, `fail`, `exitError`, `cmdKeyFromBranch`.
- `login.go:cmdLogin`, `deviceLogin`, `cmdIdentity`, `projectIdentity`, `setupIdentity`, `accountServer`, `revokeAfterFailure`.
- `init.go:cmdInit`, `writeLink`, `terminal`.
- `tickets.go:runTicketCommand` (`edit`, `comments`, `evidence`).
- `planning.go:runPlanningCommand`, `planningFlags`, `planningID`.
- `project_views.go:runProjectView` (reports and mentions).
- `management_auth.go:cmdAdmin`, `loadManagementEnv`, `managementIdentity`.
- `admin.go:parseAdminOptions`, `runAdminCommand`, `buildAdminRequest`, `executeAdminRequest`.
- `update.go:cmdUpdate`, `updateServer`, `fetch`, `checksumFor`.

## Invariants
- `loadEnv` runs `config.Find`, then `Keys.CheckBinding`, before loading any key.
- An unbound directory needs `VELVET_TOKEN`, and the YAML server must equal the trusted server from `accountServer` (`loadEnv`).
- `projectIdentity` verifies the `/me` project token kind and exact scope before any work request. The `/me` call carries the key.
- `setupIdentity` verifies setup kind through `readIdentity` for login, init's setup-credential path, and machine-login identity. Login does not check bindings. Init checks existing and selected links with `CheckBinding` before loading setup credentials unless `--relink` is explicitly confirmed (interactive confirmation or `--relink --yes`); it can instead reuse a stored project key after `projectIdentity` succeeds.
- Contextual identity (`whoami`/`where`/`me`) inside an initialized directory uses `loadEnv`, `CheckBinding`, and `projectIdentity`. Outside one, or with explicit `--server`/`--account`, it uses the saved setup login and `setupIdentity` without a binding check. Logout loads that login, sends `DELETE /me/token`, cleans up locally, and returns before `setupIdentity`; it does not check bindings (`login.go:cmdIdentity`).
- `managementIdentity` verifies management kind through `readIdentity` for admin, without `CheckBinding`.
- Project requests are scoped under `/w/<organisation>` (`env.scoped`).
- Admin commands use only management credentials from `loadManagementEnv`, never YAML, setup keys, or `VELVET_TOKEN`.
- Destructive admin, sprint activation, and sprint completion require `--yes`.
- `cmdUpdate` refuses Windows and checks the binary against `SHA256SUMS`.
- Exit codes come from `fail`: usage 2, auth 3, not found 4, network 5, API 6, scope 7, config 78.

## Side Effects
- HTTP calls to the Velvet server, including device-flow polling in `deviceLogin`.
- Opens a browser through `openBrowser` unless `--no-browser`.
- Writes `velvet.yaml`, bindings, and credentials through `internal/config`.
- `cmdUpdate` downloads from `<server>/download/` and replaces the running binary.
- Reads `VELVET_SERVER` and `VELVET_TOKEN`.

## Verification
- Run: `go test ./cmd/velvet/...` from `cli/`.
