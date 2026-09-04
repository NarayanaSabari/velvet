# Work-Log Ticketing

A self-hosted ticketing and work-log system for a small team.
Work is organised as monthly sprints containing milestones containing issues, and the issues a person worked on, together with the comments they wrote, are the record of work done.
GitHub pull requests attach to issues as proof of that work, not as a controller of it.

Linear is the reference for feel and speed, not for feature scope.
Self-hosting is the point: the team owns the data and the deployment.

## The model

**Sprint** is a calendar month, in state `upcoming`, `active`, or `completed`.
Closing a sprint freezes a snapshot - milestones completed against planned, issue counts per status, per-person activity totals - so later edits cannot silently rewrite last month's report.
Incomplete issues move to the next sprint.

**Milestone** belongs to a sprint and carries a name, description, owner, target date, and status.
Its comment thread is the periodic narrative: where this stands, and why.

**Issue** belongs to a milestone or to nothing at all.
The unfiled backlog is deliberate, because work arrives before anyone has filed it under a goal, and requiring a milestone at creation makes people skip logging entirely.
An issue has a human-readable key (`ENG-142`), a title, a Markdown description, a status, a priority from 0 to 4, an assignee, and labels.
Sub-issues nest exactly one level.

`status` is a fixed enum - `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled` - and is not user-configurable, so a status means the same thing across every issue in every report.
There is no time tracking and there are no estimates or story points: this is a record of work, not a planning tool.

**Comments** are the progress log. They hang off an issue or a milestone, thread one level deep, and parse `@mentions` on write so a "mentions of me" view never scans every body.

**Activity** is one append-only stream, written in the same transaction as the change it describes, so the feed can never disagree with the underlying data.

## Pull requests are evidence, never a controller

The worker links a PR to an issue by branch name first, then PR title or body, then manual attachment.
A PR that matches nothing is still stored and shows up in **Unlinked PRs**, because silently dropping unmatched work is how a team stops trusting the tool.

**Attaching or merging a PR never changes issue status.**
On merge the assignee is prompted - "PR merged, is ENG-142 done?" - and that is all it is: a prompt, never a transition.
The record should reflect what the person decided, not what a branch name implied.

Because webhooks are missed in practice, an hourly job re-fetches PRs updated since each repo's last successful sync and a nightly pass covers all open PRs.
A system whose correctness depends on never missing a webhook is quietly wrong within a month.

## Layout

```
api/     Go: HTTP API, queue worker, migrations - one binary, three subcommands
web/     React SPA (Vite, TanStack Query and Router, Tailwind)
e2e/     Playwright suite, run against the real Compose stack
deploy/  Compose file, Caddyfile, backup script
```

Five containers: `caddy`, `api`, `worker`, `postgres`, `redis`.
Caddy terminates TLS, serves the built SPA, and proxies `/api` and `/webhooks`, so the browser sees a single origin and the session cookie needs no cross-site handling.

The binary has three subcommands:

```
ticket migrate   apply schema migrations
ticket serve     run the HTTP API
ticket worker    run the queue consumer
```

## Running it

### With Docker Compose

```bash
cd deploy
cp .env.example .env.local          # .env.local is git-ignored
# fill in .env.local, then:
docker compose --env-file .env.local up -d --build
curl -fsS http://localhost/api/v1/health   # {"status":"ok"}
```

Migrations run as a one-shot `migrate` service that both `api` and `worker` wait on, so the schema applies exactly once instead of racing between two starting containers.
Every required variable is referenced as `${VAR:?message}`, so a missing secret fails the deploy loudly at startup rather than producing a half-configured system.

For a real deployment set `SITE_ADDRESS` to a bare hostname such as `worklog.example.com` and Caddy provisions a Let's Encrypt certificate on its own.
Set `SITE_ADDRESS=http://localhost` for local work, where there is nothing to certify.

### Without Docker

```bash
# API
cd api
DATABASE_URL=postgres://... SESSION_SECRET=$(openssl rand -hex 32) \
  go run ./cmd/ticket migrate
DATABASE_URL=postgres://... SESSION_SECRET=... go run ./cmd/ticket serve

# SPA, proxying /api to localhost:8080
cd web && npm install && npm run dev
```

Tests: `cd api && go test ./...` and `cd web && npx vitest run && npx tsc --noEmit`.
The Go tests use testcontainers, so Docker must be running for them.

## GitHub configuration

Two GitHub identities are used deliberately and kept separate.
App permissions survive any one person leaving the team, whereas a personal access token dies with its owner.

### The GitHub App - webhooks and repository reads

1. Organisation settings, Developer settings, GitHub Apps, New GitHub App.
2. Webhook URL `https://YOUR_HOST/webhooks/github`, and set a webhook secret.
3. Repository permissions: Contents read-only, Metadata read-only, Pull requests read-only.
4. Subscribe to events: Pull request, Pull request review, Push, Installation, Installation repositories.
5. Generate a private key and download the PEM.
6. Install the App on the organisation and choose which repositories map to the workspace.

Put the App ID in `GITHUB_APP_ID`, the PEM contents in `GITHUB_APP_PRIVATE_KEY`, and the webhook secret in `GITHUB_WEBHOOK_SECRET`.

The downloaded key is a multi-line PEM, so quote it when you paste it into `.env.local`, keeping the `BEGIN` and `END` lines. An unquoted value silently truncates at the first newline and every App call then fails to sign.

Then connect each repository:

```
SESSION_TOKEN=<your ticket_session cookie> GITHUB_TOKEN=<a token that can read the repo> \
  ./deploy/connect-repo.sh your-org/your-repo your-workspace-slug
```

The script resolves the numeric repository id and the App installation id for you, because GitHub scatters them across three different pages.
The worker backfills the last 90 days of pull requests on its next reconcile pass, which runs at startup and hourly after that, so the views are not empty on day one.

There is no admin screen for this yet: repository connection and member invites are scripts against the API and the database.

When it is all wired up, check it:

```
cd deploy && ./preflight.sh your-slug
```

That verifies the API answers, sign-in redirects to GitHub, a correctly signed webhook is accepted and an unsigned one refused, the private key is a complete PEM, and at least one repository and member exist. Every one of those fails silently in normal use, which is why they are worth asserting explicitly.

### The OAuth app - who is this human

Members sign in with GitHub OAuth; there are no passwords, because every member already has a GitHub account and a second credential store is a liability without a benefit.

1. Organisation settings, Developer settings, OAuth Apps, New OAuth App.
2. Authorization callback URL `https://YOUR_HOST/api/v1/auth/github/callback`.
3. Put the client ID and secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

A GitHub login must be invited to the workspace before it can sign in; a stranger who finds the URL sees a "not invited" page rather than an account.
Roles are `admin` (membership, repo connections, sprint lifecycle), `member` (create and edit issues, comment, attach PRs), and `viewer` (read).

### First workspace and invites

Sign-in is invite-gated, so the first admin cannot be invited through the app by anyone. Create the workspace and that first invite once:

```
cd deploy
./bootstrap.sh <your-github-login> "Your Team" your-slug ENG
```

Everyone after them is an ordinary invite:

```
./invite.sh <github-login> member
./invite.sh <github-login> admin
```

An invite works before the person has ever signed in, so the whole team can be seeded up front. Re-running either script changes the role rather than failing.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SITE_ADDRESS` | yes | Hostname Caddy serves and certifies |
| `BASE_URL` | yes | Origin the API builds absolute links and OAuth callbacks from |
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | Session cookie signing key, at least 32 characters |
| `POSTGRES_USER` | yes | Postgres superuser for the container |
| `POSTGRES_PASSWORD` | yes | Its password |
| `POSTGRES_DB` | no | Database name, default `worklog` |
| `PORT` | no | API listen port, default `8080` |
| `GITHUB_CLIENT_ID` | for login | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | for login | OAuth app client secret |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | HMAC secret verifying deliveries |
| `GITHUB_APP_ID` | for the worker | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | for the worker | App private key, PEM contents |
| `HTTP_PORT`, `HTTPS_PORT` | no | Host ports Caddy binds, default 80 and 443 |
| `BACKUP_S3_URL` | no | Object-storage destination for dumps |

Secrets are supplied through the environment and never committed.
`deploy/.env.example` holds variable names only; `.gitignore` covers every `.env*` except the example.

## Tests

```
cd api  && go test ./...            # domain and integration, real Postgres via testcontainers
cd web  && npx vitest run           # components
cd e2e  && npx playwright test      # the whole system, in a browser
```

The Playwright suite brings up the production Compose stack on port 8099, drives it in Chromium, and tears it down.
It runs against the real deployment rather than a dev server because several of this project's worst bugs lived there and nowhere else: a worker that crash-looped when no GitHub App was configured, a Caddy port mismatch that refused every request, and timestamps a browser could not parse.
None of those were visible to a unit test.

Auth is seeded directly rather than clicked through github.com: driving GitHub's login page would test GitHub, not this application. The seeded cookie is the same one the OAuth callback issues, so everything after sign-in is exercised for real.

### CI

`.github/workflows/ci.yml` runs all three suites on every push and pull request.
The end-to-end job depends on the other two, so a broken unit test fails fast instead of paying to build the whole stack.

The gate was checked against a deliberate regression, not just a green tree: reintroducing the timestamp bug on a branch turned CI red in the Go job with the expected message and skipped end-to-end, then the branch was deleted.

**`main` is not yet protected.** Branch protection and rulesets need GitHub Pro or a public repository, and this one is private on the free plan, so a red run reports but does not block a merge. Enable "Require status checks to pass" for `Go API`, `Web app`, and `End to end` once either applies.

## Backup and restore

`deploy/backup.sh` writes a timestamped `pg_dump -Fc` into `deploy/backups/`, uploads it when `BACKUP_S3_URL` is set, and prunes local dumps older than 14 days.
It runs under `set -euo pipefail` and treats an empty dump as a failure, because a backup that fails silently is worse than none.

Nightly, from cron on the host:

```
0 3 * * * /srv/worklog/deploy/backup.sh >> /var/log/worklog-backup.log 2>&1
```

Restore into a running stack:

```bash
cd deploy
docker compose --env-file .env.local exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d worklog --clean --if-exists \
  < backups/worklog-20260904T030000Z.dump
```

Restore drops and recreates the objects it carries, so run it against an intended target and confirm which dump you are holding first.
Check a restore periodically against a scratch database: an untested backup is a hypothesis, not a backup.

## Upgrading

Deployment is a pull and a restart:

```bash
cd deploy
git pull
docker compose --env-file .env.local up -d --build
```

The `migrate` service applies any new migrations before `api` and `worker` restart.
