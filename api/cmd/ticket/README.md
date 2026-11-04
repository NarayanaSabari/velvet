# ticket

## Overview
Single binary entry point for the API. `main.go` loads configuration, connects to Postgres and dispatches one subcommand.

## Interface
- `ticket migrate`: runs `db.Migrate`.
- `ticket serve`: runs `cfg.ValidateServe`, builds `api.NewServer(...).Handler()` and listens on `:PORT`.
- `ticket worker`: runs `worker.New(store.New(pool), client).WithSuggester(suggester).Run(ctx)`.
- `ticket eval-suggestions`: read-only replay via `worker.EvaluateSuggestions(..., 100, os.Stdout)`.

## Invariants
- `serve` fails fast when `ValidateServe` rejects `BASE_URL` or `GITHUB_INSTALLATION_URL`.
- Mail uses `mail.LogMailer` unless both `RESEND_API_KEY` and `MAIL_FROM` are set.
- The GitHub user client is built only when the GitHub App client ID or secret is set.
- `worker` starts without a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) and logs a warning instead of crashing.
- SIGINT/SIGTERM trigger `srv.Shutdown` with a 10 second timeout.

## Side Effects
- Opens a Postgres pool from `DATABASE_URL`.
- Binds a TCP listener for `serve`. `ReadHeaderTimeout` is 10 seconds.
- `eval-suggestions` calls TypeSafe and writes a report to stdout.

## Verification
- Run: `cd api && go test ./...`
