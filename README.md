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

Compose runs four long-lived containers: `caddy`, `api`, `worker`, and `postgres`.
The `migrate` and `web` services are one-shot setup containers that apply the schema and copy the built SPA into Caddy's shared volume.
Caddy terminates TLS, serves the built SPA, and proxies `/api` and `/webhooks`, so the browser sees a single origin and the session cookie needs no cross-site handling.
Postgres stores both domain data and the durable background-job queue.

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
DATABASE_URL=postgres://... go run ./cmd/ticket migrate
DATABASE_URL=postgres://... go run ./cmd/ticket serve

# SPA, proxying /api to localhost:8080
cd web && npm install && npm run dev
```

Tests: `cd api && go test ./...` and `cd web && npx vitest run && npx tsc --noEmit`.
The Go tests use testcontainers, so Docker must be running for them.

## Accounts and organisations

Open `/signin`, enter your email, and follow the mailed link to the confirmation page.
Click **Sign in** to create the session; opening the link alone never consumes it.
Links expire after 15 minutes and work once.
A reused or expired link offers a fresh sign-in request.
Email addresses are normalized to lowercase, and GitHub is optional.

A new account can create an organisation with a name, unique slug, and 2-6 letter uppercase issue prefix.
The creator becomes its first admin.
The organisation switcher remembers the last selection in the session.
Admins invite colleagues by email and role from Administration, resend invitations with a replacement token, revoke invitations, and manage existing members.
Invitations expire after seven days.
The recipient can accept while signed in with the matching address, or complete a separate mailed sign-in confirmation to join.
A different signed-in address cannot accept it.
People without memberships also see their pending invitations after ordinary sign-in and can accept without reopening the invitation mail.

Roles are `admin` (membership, GitHub, and sprint administration), `member` (create and edit work), and `viewer` (read).
Leaving, removing, or demoting a member cannot leave the organisation without an admin.
Deleting an organisation requires typing its slug and deletes its work and evidence.

Sessions use a random opaque bearer token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 hash is stored.
Sign-in and invitation tokens arrive in URL fragments and are submitted only after a confirmation click.
Sign-in issuance is limited to five requests per normalized address and 20 per client IP in 15 minutes.
Production requires `RESEND_API_KEY` and `MAIL_FROM` from a verified sending domain.
On HTTP localhost without a Resend key, the log mailer writes confirmation links to the API container log.

## GitHub configuration

### App settings and credentials

Use a GitHub App that can be installed by any account or organisation.
Configure these settings on the App:

1. Setup URL: `https://YOUR_HOST/api/v1/github/setup`.
2. User-authorization callback URL: `https://YOUR_HOST/api/v1/auth/github/callback`.
3. Disable **Request user authorization (OAuth) during installation** and **Redirect on update**.
4. Webhook URL: `https://YOUR_HOST/webhooks/github`, with a matching webhook secret.
5. Repository permissions: Contents read-only, Metadata read-only, Pull requests read-only.
6. Subscribe to Pull request, Pull request review, and Push events.
   Installation lifecycle and repository-selection events are delivered automatically.
7. Generate a private key and configure the App's user-authorization client secret.

Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_WEBHOOK_SECRET` on the API deployment.
The worker needs the App ID and private key.
The App client credentials are distinct from the old OAuth App's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; those legacy values no longer enable sign-in.
Quote the complete multiline PEM, retaining its BEGIN and END lines.

### Connect and verify ownership

An organisation admin clicks **Connect GitHub** in Administration, selects the installation, and completes GitHub user authorization.
The server verifies both access to that installation and ownership: the personal account owner or an active GitHub organisation owner.
Read access and delegated installation management alone are insufficient in this release.
Each organisation supports one live installation, and an installation cannot belong to several organisations.
The temporary user token is discarded after verification, and this flow does not link the admin's profile.

Repositories are discovered from the App's complete granted repository list.
There is no manual repository connection form or setup script.
Existing installations migrated from the old release show **Verify GitHub ownership** and preserve existing evidence until that verification permits further discovery.
After verification, **Retry sync** retries a failed repository sync.
Repository ownership conflicts are reported in Administration and never move another organisation's repository.
The worker backfills 90 days of PRs on first synchronization and reconciles active repositories hourly.

### Access changes and evidence

Removing repository access marks the repository **Disconnected** and stops synchronization while retaining PRs, commits, reviews, links, and issue evidence.
Adding access again reconnects the same repository row.
Suspended installations stop syncing until GitHub reports them active again.
If Administration shows a suspended installation with a state-check error (`sync_failed`), use **Retry sync** to check GitHub's current state after resolving the provider error.

**Disconnect GitHub** explains how to uninstall the App on GitHub and links to its settings.
Only a correctly signed `installation.deleted` delivery permanently marks that installation deleted and releases its organisation binding.
A current-state API 404 fails closed, preserves the binding and evidence, and does not prove deletion.
Restore provider access or recover the signed deletion delivery through GitHub; follow the [rollout runbook](docs/operations/organisations-rollout.md) for operational recovery.
Deleting an organisation itself still deletes its evidence.

### Profile linking

Open Profile inside an organisation to link or unlink a personal GitHub account.
Linking uses the App's user-authorization flow, does not create a session, and refuses an account already linked to another user.
User tokens are not retained.
Email-only members appear by name when available, otherwise by email.
Linked GitHub logins support existing mentions and PR-author attribution within the organisation.

### Local development and verification

A webhook URL on localhost cannot receive GitHub deliveries.
For a local trial, active, verified repositories can reconcile PR evidence hourly without deliveries.
Installation deletion still requires a signed webhook; polling cannot release a stale binding after an uninstall.
Expose localhost through a tunnel when testing real lifecycle deliveries, and update the App's webhook URL to that public address.
The setup and user-authorization callback URLs can use `http://localhost:8088` because those redirects run in the user's browser.

`GITHUB_INSTALLATION_URL`, `GITHUB_AUTHORIZATION_URL`, `GITHUB_TOKEN_URL`, and `GITHUB_API_URL` are optional test-provider or GitHub Enterprise overrides.
Ordinary GitHub.com use leaves them empty and uses the App slug for the installation URL.
The browser must reach installation and authorization endpoints; the API and worker must reach token and REST endpoints.

After configuring a deployment, `cd deploy && ./preflight.sh your-slug` checks health, the sign-in page, mail/App configuration, signed and invalid webhook handling, the PEM, and active repositories and memberships.
It sends diagnostic ping webhooks but does not send mail or perform signup.
It cannot prove mail delivery, owner authorization, or App dashboard settings; complete the runbook's smoke checks.

`./deploy/verify-setup.sh` runs the shared isolated browser onboarding suite: email confirmation, organisation creation, invitations, owner verification, signed evidence, sync retry, and retention/reconnection.
`./deploy/verify-localhost.sh` is an alias for the same suite, including signed webhooks.
Both accept browser-runner arguments such as `--list` and preserve the disposable stack.
Polling without any delivery is covered separately by the Go worker test `TestReconcileAloneLinksWithoutAnyWebhook`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SITE_ADDRESS` | yes | Hostname Caddy serves and certifies |
| `BASE_URL` | yes | Origin for mail links, App callbacks, and same-origin mutation checks |
| `DATABASE_URL` | yes | Postgres connection string |
| `POSTGRES_USER` | yes | Postgres superuser for the container |
| `POSTGRES_PASSWORD` | yes | Its password |
| `POSTGRES_DB` | no | Database name, default `worklog` |
| `PORT` | no | API listen port, default `8080` |
| `RESEND_API_KEY`, `MAIL_FROM` | for HTTPS API | Mail delivery key and sender on a verified domain; required only by `serve` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | for GitHub authorization | GitHub App user-authorization credentials for owner verification and profile linking |
| `GITHUB_APP_SLUG` | for GitHub connection | App URL slug used by the default installation redirect |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | HMAC secret verifying deliveries |
| `GITHUB_APP_ID` | for the worker | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | for the worker | App private key, PEM contents |
| `GITHUB_INSTALLATION_URL`, `GITHUB_AUTHORIZATION_URL`, `GITHUB_TOKEN_URL`, `GITHUB_API_URL` | no | Test-provider or Enterprise overrides; leave empty for GitHub.com |
| `HTTP_PORT`, `HTTPS_PORT` | no | Host ports Caddy binds, default 80 and 443 |
| `CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT` | no | Container ports matching `SITE_ADDRESS`, default 80 and 443 |
| `PROXY_SUBNET`, `PROXY_CADDY_IP`, `PROXY_API_IP` | no | Private proxy network and fixed addresses, default `172.30.75.0/24`, `172.30.75.2`, `172.30.75.3` |
| `TRUSTED_PROXY_CIDRS` | outside Compose | Explicit trusted proxy CIDRs; Compose derives the API value from `PROXY_CADDY_IP/32` |
| `BACKUP_S3_URL` | no | Object-storage destination for dumps |

Secrets are supplied through the environment and never committed.
Use the table above for the feature's required settings; existing environment templates may predate email sign-in and App authorization.
For coexisting Compose stacks, choose a distinct project, available ports, a non-overlapping `PROXY_SUBNET`, and both fixed addresses `PROXY_CADDY_IP` and `PROXY_API_IP` inside that subnet.
Caddy's address is the only trusted source of forwarded client IPs, so updating only the subnet is insufficient.

## Tests

```
cd api  && go test ./...            # domain and integration, real Postgres via testcontainers
cd web  && npx vitest run           # components
cd e2e  && env -u NO_COLOR npx playwright test  # the whole system, in a browser
```

The Playwright suite starts or reuses the disposable `worklog-e2e-organisations` Compose stack on port 18399, with the local provider on 18599, and leaves it running.
Install its dependencies and Chromium first; see [the browser test guide](e2e/README.md) for focused runs, safety checks, rebuilds, and explicit cleanup.
It runs against the real deployment rather than a dev server because several of this project's worst bugs lived there and nowhere else: a worker that crash-looped when no GitHub App was configured, a Caddy port mismatch that refused every request, and timestamps a browser could not parse.
None of those were visible to a unit test.

The onboarding suite drives email confirmation and both GitHub callbacks through a local provider, using the real API, worker, database, and log mailer.
Existing work/evidence specs use seeded email accounts and sessions to focus on their respective workflows.
Run deployment wiring and guarded entrypoint regressions from the repository root with `node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs` after the disposable test environment has been generated.

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

Every push to `main` deploys itself, once the Go, web, and end-to-end jobs are green.
The `images` job in `.github/workflows/ci.yml` builds both images for x86 and pushes them to GitHub Container Registry tagged with the commit, and the `deploy` job then connects to the host over SSH and runs `deploy/remote-deploy.sh` for that tag.
The host never builds: it pulls the images and restarts what changed, and the job fails unless the API answers over the public URL afterwards.
A pull that fails leaves the previous containers running.

For schema-compatible application rollback, Actions can rebuild and redeploy a selected commit through Run workflow.
After `0006_email_identity.sql` commits, selecting an old commit is unsafe: rollback requires stopping writers and restoring the verified pre-contract backup before running the foundation release.
Follow the [two-release organisations runbook](docs/operations/organisations-rollout.md) before either organisations release, including the approved email backfill, ownership preflights, stopped legacy writers, and fresh verified backup immediately before `0006`.
Merging to `main` authorizes the automatic production deployment and requires separate operator approval from opening a review PR.

The host side is one restricted SSH key.
Its `authorized_keys` entry forces a single command that accepts a commit sha, checks it out, and runs the deploy script, so the key can do nothing else:

```
command="/home/ubuntu/worklog-deploy-entry.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...
```

The repository holds three secrets: `DEPLOY_SSH_KEY`, the private half of that key; `DEPLOY_HOST`; and `DEPLOY_KNOWN_HOSTS`, the host's public key from `ssh-keyscan`, so the job refuses to talk to an impostor.
The registry credential is the job's own short-lived token, passed to the host on stdin, so nothing that can pull the private images is stored on the host.

A host that can build for itself can still upgrade by hand:

```bash
cd deploy
git pull
docker compose --env-file .env.local up -d --build
```

The `migrate` service applies any new migrations before `api` and `worker` restart.
