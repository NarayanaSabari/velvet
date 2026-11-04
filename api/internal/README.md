# internal

## Overview
Private packages of the API module. `testdata/github` (webhook payload fixtures) and `testutil` (Testcontainers test helpers) are test-only and have no contract.

## Interface
- api: [./api/README.md](./api/README.md) - HTTP routes, middleware, webhook intake, activity stream.
- auth: [./auth/README.md](./auth/README.md) - session cookie helpers.
- config: [./config/README.md](./config/README.md) - environment loading and serve validation.
- db: [./db/README.md](./db/README.md) - Postgres pool and embedded migrations.
- fracdex: [./fracdex/README.md](./fracdex/README.md) - fractional ordering keys.
- github: [./github/README.md](./github/README.md) - GitHub App and user OAuth clients.
- imageupload: [./imageupload/README.md](./imageupload/README.md) - image validation and sanitizing.
- linker: [./linker/README.md](./linker/README.md) - pure issue-key matcher for pull requests.
- mail: [./mail/README.md](./mail/README.md) - `Mailer` with log and Resend senders.
- store: [./store/README.md](./store/README.md) - Postgres data access and job queue.
- typesafe: [./typesafe/README.md](./typesafe/README.md) - TypeSafe (Jev) client.
- worker: [./worker/README.md](./worker/README.md) - queue, reconcile and suggestion loop.

## Invariants
- None at this level. No Go files live directly in `internal/`. See each child contract.

## Side Effects
- None at this level. See each child contract.
