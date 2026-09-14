# Self-Serve Organisations Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing worktree.
> Steps use checkbox syntax for tracking.

**Goal:** Email sign-in, organisation creation, email invitations, and verified GitHub installation connection with historical evidence preserved.

**Architecture:** Postgres owns identity, one-use authentication state, membership invariants, and the existing durable job queue.
Magic links require an explicit confirmation POST.
Installation binding verifies both Velvet administration rights and GitHub account ownership before atomically scheduling repository reconciliation.

**Tech Stack:** Existing Go, pgx, Postgres, React, TanStack Query/Router, Vitest, and Compose Playwright stack.
Keep the versions pinned in the repository.

**Spec:** [Self-Serve Organisations design](../specs/2026-09-07-saas-organisations-design.md)

## Global constraints

- Work from the existing linked worktree on `t3code/saas-organisations`.
- This plan supersedes the previous sixteen-task version, including its embedded implementations.
- Preserve commits `409c5ca` (additive schema), `35b2358` (mail configuration), and `5184ff7` (mail package).
- Completed code is a starting point, not proof of feature integration.
- Do not change already deployed migration `0005_organisations.sql`.
- Deploy foundation and contract changes in separate releases; local feature development can proceed while foundation deployment awaits approval.
- Run Go commands in `api/`, web commands in `web/`, and browser suites in `e2e/`.
- Go module: `github.com/NarayanaSabari/velvet-otter-lab/api`.
- Use real Postgres for transactional tests and the real Compose stack for user journeys.
- Tokens contain 32 random bytes encoded with `base64.RawURLEncoding`; store SHA-256 hashes.
- Login TTL: 15 minutes; invite TTL: seven days; installation and authorization state TTL: 15 minutes.
- Per-address limit: 5 login issues in 15 minutes; per-IP limit: 20, including login issues from invites.
- Email normalization trims surrounding whitespace and lowercases; validate one mailbox, not a display-name address list.
- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`; prefix: `^[A-Z]{2,6}$`.
- Reserved slugs: `admin api auth check-email expired invite invites me new orgs settings signin signout w webhooks`.
- Interface copy says organisation; storage and Go names retain workspace.
- Keep the existing JSON error envelope and existing domain routes.
- Do not read or edit environment files without permission.
- Each implementation task ends with its targeted checks, diff review, identity verification, a focused commit, and a push.
- Obtain approval before merges, deployments, production backfills, and deletions of production records.
- No live migration or GitHub App configuration changes are part of plan preparation.

## File responsibilities

| Area | Files |
| --- | --- |
| Contract and migration tests | `api/internal/db/migrations/0006_email_identity.sql`, `api/internal/db/migrate_test.go` |
| Email identity and session storage | `api/internal/store/user.go`, `api/internal/store/session.go`, new `login_token.go` |
| Organisation and membership mutations | new `api/internal/store/workspace.go`, `api/internal/api/org.go`; existing `membership.go` |
| Invitations | new `api/internal/store/invite.go`, `api/internal/api/invite.go` |
| Email HTTP flow | new `api/internal/api/email_auth.go`; existing `auth.go`, `server.go`, `middleware.go` |
| GitHub verification | new `api/internal/github/user_auth.go`, `api/internal/store/github_setup.go`, `api/internal/api/github_setup.go`, `github_link.go` |
| Repository lifecycle | new `api/internal/store/installation.go`; existing `pull_request.go`, `worker/installation.go`, `worker/reconcile.go`, `worker/worker.go` |
| Runtime integration | `api/internal/config/config.go`, `api/cmd/ticket/main.go`, `deploy/docker-compose.yml`, `deploy/Caddyfile` |
| Auth and organisation screens | new files in `web/src/features/auth/`, `features/orgs/`, `features/profile/` |
| Administration | `web/src/features/admin/Admin.tsx` and new `InvitePanel.tsx`, `GitHubPanel.tsx`, `DangerPanel.tsx` |
| Email-only presentation | `web/src/lib/types.ts`, new `lib/userLabel.ts`, existing shell, comments, feed, reports, assignee selectors |
| End-to-end integration | `e2e/tests/fixtures.ts`, new `onboarding.spec.ts`, new `e2e/github-stub.mjs`, stack scripts |
| Operations | `README.md`, new `docs/operations/organisations-rollout.md` |

Every new Go implementation file has a corresponding `_test.go` file.
Update existing API, store, and web tests alongside the affected behavior.

## Task 1: Prepare the foundation release and upgrade contract

**Dependencies:** None.
**Deliverable:** A reviewable foundation branch and a precise rollout runbook, without running production writes.

- [ ] Inspect `git show 409c5ca --stat` and verify its schema is additive.
- [ ] Create `t3code/organisations-foundation` at `409c5ca` without switching the active worktree.
  Review its entire diff against the actual main branch before publishing.
  If main has advanced, integrate in an isolated worktree rather than resetting the feature branch.

```bash
git branch t3code/organisations-foundation 409c5ca
git diff origin/main...t3code/organisations-foundation --stat
```

- [ ] Write `docs/operations/organisations-rollout.md` with the exact two-release sequence.
  The foundation image must exclude the later mail validation commit, which currently also rejects workers without mail settings.
- [ ] Describe backup, foundation deployment, read-only preflight, operator-provided email mapping by user UUID, and a second preflight immediately before contract migration.
  The legacy OAuth route can create additional email-less users between the two releases.
- [ ] Include these read-only preflight queries:

```sql
SELECT id, github_login FROM app_user WHERE email IS NULL OR btrim(email) = '';
SELECT id, workspace_id, invited_login FROM membership WHERE user_id IS NULL;
SELECT installation_id FROM repo
GROUP BY installation_id HAVING count(DISTINCT workspace_id) > 1;
SELECT workspace_id FROM repo
GROUP BY workspace_id HAVING count(DISTINCT installation_id) > 1;
```

- [ ] Specify stopping the old API and worker before applying `0006`.
  A failed contract migration leaves `0005` intact; restore the previous application only if the contract transaction did not commit.
  After a successful contract migration, rollback requires restoring the backup with a maintenance window, not simply running old code.
- [ ] Verify with `git diff --check`; push the foundation branch after reviewing its content.
  Prepare its PR description with validation evidence; merge and deployment remain separate approval points.

## Task 2: Make nullable GitHub identity safe throughout the application

**Dependencies:** Existing `0005`.
**Deliverable:** Existing domain behavior works for users without GitHub.

**Interfaces:** Keep `store.User` with `ID uuid.UUID`, `Email string`, `GitHubID *int64`, `GitHubLogin *string`, `Name string`, and `AvatarURL string`.
Add `UpsertUserByEmail(ctx context.Context, email string) (User, error)`.
During the foundation-compatible phase retain the old OAuth helpers until Task 4 retires them.

- [ ] Add a failing integration test that inserts an email-only member, then reads its session, assignee list, comment, latest milestone comment, feed, and report through real handlers.
  Update every user projection, including `store/comment.go`, `activity.go`, `milestone.go`, `report.go`, `mention.go`, and `snapshot.go`.
- [ ] Run `go test ./internal/store ./internal/api -run EmailOnly -count=1` and capture the null-scan failure.
- [ ] Implement email upsert using the actual expression-index conflict target:

```sql
INSERT INTO app_user (email)
VALUES ($1)
ON CONFLICT (lower(email)) DO UPDATE SET email = EXCLUDED.email
RETURNING id, email, github_id, github_login, name, avatar_url;
```

- [ ] Preserve outer-join null authors independently of nullable GitHub fields.
  Never attribute unmatched GitHub evidence by comparing empty strings.
  Keep member emails visible only in already membership-scoped responses and authenticated personal responses.
- [ ] Add the web helper and use it throughout user labels:

```ts
export function userLabel(user: {
  name?: string
  email?: string
  github_login?: string | null
} | null | undefined): string {
  return user?.name || user?.email || user?.github_login || 'Someone'
}
```

- [ ] Update TypeScript fixtures to permit nullable GitHub fields, preserve linked handle mentions, and test an email-only assignee and comment author.
- [ ] Run `go test ./internal/store ./internal/api -count=1`, then `npm test` and `npm run build`.
  Commit and push only after the existing domain tests still pass.

## Task 3: Issue login tokens with atomic rate limits

**Dependencies:** Task 2.
**Files:** New `store/login_token.go`, corresponding tests, mail integration tests.
**Interface:**

```go
func (s *Store) IssueLoginToken(ctx context.Context, email, ip string, inviteID *uuid.UUID) (string, error)
var ErrRateLimited = errors.New("rate limited")
```

- [ ] Write a concurrent real-Postgres test sending 30 requests for one address from different IPs; exactly five issues succeed.
  Repeat with different addresses sharing one IP; exactly twenty succeed.
  Include uppercase/whitespace normalization, expiry-window boundaries, and invite-originated requests.
- [ ] Run `go test ./internal/store -run LoginToken -count=1` to observe failure.
- [ ] In a transaction acquire deterministic namespaced advisory locks for normalized email and normalized IP, always email before IP.
  Count and insert using that same transaction; never count outside the lock.

```sql
SELECT pg_advisory_xact_lock(hashtextextended('login-email:' || $1, 0));
SELECT pg_advisory_xact_lock(hashtextextended('login-ip:' || $1, 0));
SELECT count(*) FROM login_token
WHERE lower(email) = $1 AND created_at > now() - interval '15 minutes';
SELECT count(*) FROM login_token
WHERE request_ip = $1 AND created_at > now() - interval '15 minutes';
```

- [ ] Generate the token with `crypto/rand`, persist only its hash, and return the raw value only to the mail sender.
  A mail delivery failure retains the issuance row so repeated failures do not bypass limits.
- [ ] Test Resend timeout/non-2xx responses without logging tokens or provider response bodies.
  Use a bounded HTTP timeout.
- [ ] Run the targeted tests and existing `./internal/mail` tests; commit and push.

## Task 4: Invitations and the email identity contract

**Dependencies:** Tasks 2-3.
**Files:** New `store/invite.go`, `0006_email_identity.sql`; existing fixtures, user membership storage, migration tests.
**Interfaces:**

```go
type Invite struct {
    ID, WorkspaceID uuid.UUID
    Email, Role string
    ExpiresAt time.Time
}
func (s *Store) ListMyInvites(ctx context.Context, userID uuid.UUID) ([]Invite, error)
func (s *Store) AcceptMyInvite(ctx context.Context, inviteID, userID uuid.UUID) (Membership, error)
func (s *Store) AcceptInviteToken(ctx context.Context, token string, userID uuid.UUID) (Membership, error)
```

- [ ] Add tests for same-email acceptance, wrong-email refusal, expired/revoked invites, existing membership preservation, resend invalidating tied login tokens, and two simultaneous acceptances.
  Existing members retain their role; accepting an invite must never silently promote or demote them.
- [ ] Test the upgrade from a populated `0005` database, not only an empty latest-schema database.
  A new internal-package test in `db/migrate_upgrade_test.go` applies embedded files through `0005`, records them in `schema_migration`, seeds old records, then calls `Migrate`.
  Keep existing external-package tests unchanged; the new helper can access the private migration filesystem.
- [ ] Add `0006` with preflight exceptions before any irreversible contract change:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user WHERE email IS NULL OR btrim(email) = '') THEN
    RAISE EXCEPTION 'backfill app_user.email before applying 0006';
  END IF;
  IF EXISTS (SELECT 1 FROM membership WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'resolve unclaimed memberships before applying 0006';
  END IF;
END $$;
ALTER TABLE app_user ALTER COLUMN email SET NOT NULL;
ALTER TABLE membership ALTER COLUMN user_id SET NOT NULL;
DROP INDEX membership_workspace_login_idx;
ALTER TABLE membership DROP COLUMN invited_login;
DROP INDEX membership_user_idx;
ALTER TABLE membership ADD UNIQUE (workspace_id, user_id);
```

- [ ] Replace the membership user foreign key's `ON DELETE SET NULL` with `ON DELETE CASCADE`, consistent with non-null membership identity.
  Remove all production uses of `invited_login` and GitHub-login invitation helpers in this task.
  Remove the old GitHub sign-in and session-creation callback routes and their upsert helpers in `api/auth.go` and route registration; retain existing session validation and logout.
  Convert legacy route tests to assert removal alongside the schema cutover.
  Tasks 4 and 5 are not separate deployment milestones; email sign-in must be complete before releasing the contract.
  Move fixtures to explicitly populated email accounts and real user memberships.
- [ ] Preserve rate-limit counters when invitations cascade away: change the login-token invite foreign key to `ON DELETE SET NULL`, and invalidate associated tokens before invite deletion.
  Test that deleting an organisation retains its recent issuance rows, prevents token use, and does not reset either issuance limit.
- [ ] Add remaining contract schema used by Tasks 7-9: repository `disconnected_at`; installation `deleted_at`, `repos_synced_at`, sanitized `sync_error`, and `sync_generation bigint NOT NULL DEFAULT 0`; setup phase/session/claim/completion fields; authorization-state table with purpose, session hash, user, optional setup reference, verifier, expiry, claim and completion fields.
  Add foreign keys to the existing session/user/setup rows.
  Authorization-state tokens and session references use hashes.
- [ ] Assert and backfill existing installation ownership from repositories before creating the unique non-null `workspace_id` index.
  Keep deleted installations' rows for historical repository foreign keys.
  Add `ownership_verified_at timestamptz NULL`, leaving it null for every migrated installation.
  A historical manual link is not authorization to discover additional repositories.
  Only the verified owner flow in Task 7 may set this timestamp; preserve existing repository evidence while awaiting verification.
- [ ] Implement invite replacement by revoking the previous row and inserting a new row, under the workspace lock.
  Return the replacement id to the admin UI.
  Token preview omits token hashes.
  Acceptance checks email and current expiry/revocation under locks, creates membership, marks acceptance, and records activity in one transaction.
- [ ] Run `go test ./internal/db ./internal/store ./internal/api -count=1`.
  Preserve meaningful old authorization tests by converting fixtures rather than deleting security assertions.
  Commit and push.

## Task 5: Complete the confirmation POST and mail runtime wiring

**Dependencies:** Tasks 3-4.
**Files:** New `api/email_auth.go`, existing auth/server/config/main/middleware, Compose, Caddy, tests.
**Interfaces:**

```go
type LoginResult struct {
    SessionToken string
    Next string
}
func (s *Store) ConfirmLogin(ctx context.Context, token string) (LoginResult, error)
```

HTTP contracts:

```text
POST /api/v1/auth/email     {"email":"person@example.com"} -> 202 {"status":"sent"}
POST /api/v1/auth/magic     {"token":"..."} -> 200 {"next":"/w/lab"} plus session cookie
Invalid email -> 400 invalid_request
Dead login or tied invite -> 410 expired
Storage failure -> 500 internal
GET /api/v1/auth/magic -> 405; no cookie and no token consumption
```

- [ ] Add handler tests with a recording mailer for the above contracts, duplicate POST, expired links, and wrong-origin requests.
  Prove a failed invitation acceptance leaves no session, user, or consumed login token.
- [ ] Run `go test ./internal/api -run 'Email|Magic|Confirm' -count=1`.
- [ ] Implement confirmation in one store transaction: discover the invite's workspace without changing state, lock workspace first if present, atomically consume the token, upsert the user, validate/accept the invite, and insert the session.
  All intermediate failures roll back.
  Insert session.last_workspace_id for an accepted invitation.
- [ ] Require same-origin JSON for browser mutations; reject cross-origin requests and non-JSON mutations.
  Tests explicitly set the configured Origin.
  Do not apply browser Origin requirements to GitHub webhook deliveries.
- [ ] Configure trusted proxy CIDRs for the API and normalize IP addresses with `net/netip`.
  Trust forwarded headers only from an explicitly trusted peer, walk the chain from the right, and test spoofed headers on a direct connection.
  Verify the Compose Caddy-to-API path supplies the intended client address.
- [ ] Wire the existing mail package into `NewServer` with an explicit dependency struct and update all constructors/fixtures.
  Use `/signin/confirm#token=` in sign-in templates.
- [ ] Move production mail validation from unconditional `config.Load` into a serve-only validation method.
  Test that HTTPS `worker` and `migrate` do not require mail secrets; HTTPS `serve` does.
  Pass mail settings to the API service.
- [ ] Verify GitHub session-creation routes remain removed, keep logout/session validation, and retain existing cookie TTL and attributes.
  Add expired authentication-record cleanup to existing maintenance work without deleting live tokens.
- [ ] Run config, command, auth, mail, and store tests; commit and push.

## Task 6: Organisation APIs, invitation APIs, and membership invariants

**Dependencies:** Tasks 4-5.
**Files:** New `store/workspace.go`, `api/org.go`, `api/invite.go`; existing membership, session and stream files.
**Interfaces:** HTTP remains the boundary; use existing `store.Membership` and error sentinels.

```text
POST /orgs {name,slug,issue_prefix} -> 201 Membership
DELETE /w/{slug} {confirm:slug} -> 204
POST /w/{slug}/leave -> 204
PATCH /w/{slug}/memberships/{id} {role} -> 200 WorkspaceMembership
DELETE /w/{slug}/memberships/{id} -> 204
GET /me/invites -> {"invites":[]}
POST /me/invites/{id}/accept -> 200 Membership
POST /invite/preview {token} -> {invite,signed_in,email_matches}
POST /invite/accept {token} -> 200 Membership or 202 {status:"sent"}
GET /w/{slug}/invites -> {"invites":[]}
POST /w/{slug}/invites {email,role} -> 201 Invite
POST /w/{slug}/invites/{id}/resend -> 200 replacement Invite
DELETE /w/{slug}/invites/{id} -> 204
```

All paths above are relative to `/api/v1`.

- [ ] Write route tests for admin/member/viewer access and a foreign organisation for every mutation.
  Test concurrent leave/demotion/removal with two admins, requiring at least one admin afterward.
- [ ] Run `go test ./internal/api ./internal/store -run 'Organisation|Invite|LastAdmin' -count=1`.
- [ ] Implement all membership-changing transactions with this lock order:

```sql
SELECT id FROM workspace WHERE id = $1 FOR UPDATE;
SELECT role FROM membership WHERE workspace_id = $1 AND user_id = $2;
SELECT count(*) FROM membership WHERE workspace_id = $1 AND role = 'admin';
```

Validate actor role inside the transaction after the workspace lock.
Do not use aggregate `count(*) FOR UPDATE`, which Postgres rejects.
Create organisation and creator membership atomically.
Reuse the lock order in invitation acceptance, GitHub binding, and organisation deletion.

- [ ] Retain author/history references when removing a membership.
  Recheck membership before each SSE activity emission and heartbeat so a removed user cannot continue receiving events.
- [ ] Persist last workspace after successful scoped access, and only return it from `/me` if the membership still exists.
  Fallback ordering is workspace creation time then UUID.
- [ ] Invite preview is read-only despite POST transport; it sends no mail.
  Signed-out acceptance uses Task 3 issuance limits.
  Revoke/resend checks both workspace and invite id.
  Map last-admin conflicts to 409, foreign resources to 404, and invalid roles to 400.
- [ ] Run API/store/stream tests; commit and push.

## Task 7: Verify GitHub authorization and link profiles

**Dependencies:** Tasks 4-6.
**Files:** New `github/user_auth.go`, `store/github_setup.go`, `api/github_link.go`, `api/github_setup.go`; existing auth client, config, main, tests.

- [ ] Write an HTTP stub covering authorization, token exchange, `GET /user`, paginated `GET /user/installations`, and `GET /user/memberships/orgs`.
  Test a matching personal owner, an active organisation admin, a reader of one repository, a pending member, a foreign installation, and GitHub failures.
- [ ] Require the reader and foreign-installation scenarios to fail even when the App JWT can read that installation.
  Run `go test ./internal/github ./internal/api -run 'GitHub|Setup' -count=1`.
- [ ] Add separate configuration `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, keeping the GitHub App id/private key for installation tokens.
  Disable automatic OAuth during installation and redirect-on-update in the operator runbook.
- [ ] Persist state tied to the exact Velvet session hash, user, purpose, and expiry.
  Generate an S256 PKCE challenge:

```go
digest := sha256.Sum256([]byte(verifier))
challenge := base64.RawURLEncoding.EncodeToString(digest[:])
```

- [ ] Atomically claim a state by hash, session, user, expiry, phase, and unused status before exchanging a code.
  A wrong session must not consume the state.
  A failed exchange requires a fresh flow; never retry a spent code.
- [ ] For installation flows, verify candidate membership in the installation list, then verify account ownership.
  Personal account ids must equal the authenticated GitHub user id.
  Organisation ids must match an active admin entry from the paginated membership list.
  Reject unsupported account types and any incomplete API response.
- [ ] For profile flows, update the signed-in user's GitHub fields with existing uniqueness protection.
  Never create a Velvet session from GitHub.
  Installation verification does not link the profile.
  Unlink sets both fields null and clears caches that expose the old identity.
- [ ] Discard access and refresh tokens after the callback.
  Store only a completion receipt for the same-session redirect until expiry.
  Never log the authorization code, verifier, state, or provider response body.
- [ ] Run GitHub client and authorization tests including PKCE mismatch, wrong-purpose state, session switch, expiry, conflicting link, and unlink.
  Commit and push.

## Task 8: Bind installations and preserve repository ownership

**Dependencies:** Task 7.
**Files:** New `store/installation.go`; existing setup handlers, job and pull-request stores.
**Interface:** The binding transaction accepts a server-verified setup reference, never an unauthenticated installation id from a generic API.

- [ ] Add tests for concurrent attempts to bind one installation into different organisations, two installations into one organisation, same-org repeat, and an admin demoted during authorization.
- [ ] Run `go test ./internal/store ./internal/api -run 'BindInstallation|Setup' -count=1`.
- [ ] Lock workspace first, recheck admin membership, then serialize installation creation/binding by installation id.
  Use the unique workspace index as a second guard.
  State completion, binding, and job enqueue commit together.
- [ ] Use the existing `EnqueueJob(ctx, tx, kind, payload)` with:

```json
{"installation_id":99,"workspace_id":"workspace-uuid","generation":1}
```

The job kind is `sync_installation_repos`.
Increment `sync_generation` for each requested authoritative sync.
Duplicate jobs are harmless because application checks workspace, installation, and generation.

- [ ] Update repository upsert without ever changing a foreign workspace:

```sql
INSERT INTO repo (workspace_id, installation_id, github_id, owner, name)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (github_id) DO UPDATE
SET installation_id = EXCLUDED.installation_id,
    owner = EXCLUDED.owner, name = EXCLUDED.name, disconnected_at = NULL
WHERE repo.workspace_id = EXCLUDED.workspace_id
RETURNING id;
```

No returned row means a tenant conflict, including disconnected historical rows.
Rollback the whole repository-list application and expose a sanitized conflict status.

- [ ] Backfill/reconnect repositories within the same organisation while preserving their row ids, PR links, comments, and sync history.
  Test reinstall with a new installation id and historical evidence present.
- [ ] Add `GET /w/{slug}/github` returning `{installation, status, error}`, where status is `disconnected`, `syncing`, `connected`, `suspended`, or `error`.
  Add admin-only `POST /w/{slug}/github/sync` to retry failed work without reauthorizing an already verified bound installation.
  Return `verification_required` for migrated bindings with null `ownership_verified_at`; neither manual retry, lifecycle webhooks, nor scheduled reconciliation may discover new repositories until verification succeeds.
  Test this gate on all three entry points, and expose the verification action in Administration.
- [ ] Run binding and isolation tests; commit and push.

## Task 9: Reconcile lifecycle events without deleting evidence

**Dependencies:** Task 8.
**Files:** Existing worker installation, reconcile, PR, review, push handlers and store queries.

- [ ] Seed a repo, PR, review, commit, and issue link.
  Deliver a signed removal webhook through the real handler and drain the queue; assert the evidence remains readable and reconciliation skips the repo.
  Redeliver, re-add, suspend, unsuspend, uninstall, and reconnect.
- [ ] Run `go test ./internal/worker ./internal/api -run 'Installation|Evidence|Webhook' -count=1`.
- [ ] Repository-access events enqueue a full installation listing instead of trusting only added/removed arrays.
  Fetch every page before opening the application transaction.
  Any timeout, rate limit, partial listing, or parsing failure retries without disconnecting records.
- [ ] Apply a successful snapshot only if its generation and binding still match.
  In the transaction lock the installation, preserve owned repository rows, mark absent rows disconnected, stamp success, and clear the sanitized error.
  A stale job completes without applying its snapshot.
- [ ] Treat deletion as terminal for an installation id: mark all its repos disconnected, mark deletion, and clear its binding.
  A stale create/add event cannot resurrect it.
  Reconcile suspension against current GitHub state; do not clear suspension on arbitrary events.
- [ ] Parse installation id in PR, review, and push events.
  Gate writes on matching active repository ownership and installation; queued events from an old installation cannot update a newly reconnected repo.
- [ ] Preserve hourly PR reconciliation/backfill, but skip inactive repos and installations.
  A failing installation must not prevent later installations from reconciling.
  Surface exhausted sync retries through Task 8 status and retry endpoint.
- [ ] Run worker/store tests with transient errors and overlapping sync jobs; commit and push.

## Task 10: Deliver the onboarding and administration screens

**Dependencies:** Tasks 5-9.
**Files:** Auth/org/profile/admin components from the file map; router/root/Shell/session hooks/API types; existing web tests.

- [ ] Write component tests for explicit confirmation, empty-page invites, wrong-email invitation, organisation creation, role restrictions, suspended connection, and retry.
  In the confirmation test, assert rendering performs no mutation, then click Sign in:

```ts
expect(fetchMock).not.toHaveBeenCalled()
await user.click(screen.getByRole('button', { name: 'Sign in' }))
expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/magic',
  expect.objectContaining({ method: 'POST' }))
```

The test renders the standalone confirmation component, not a shell that fetches `/me`.
- [ ] Run `npm test -- --run` and observe the missing-flow failures.
- [ ] Add public `/signin`, `/signin/confirm`, `/check-email`, `/expired`, and `/invite`.
  Read bearer tokens from fragments into component state.
  Never auto-submit during mounting or effects; clear the fragment on success.
- [ ] Implement root landing using current memberships plus a validated last workspace.
  `/orgs/new` renders the identity, sign-out action, pending invitations, and creation form.
  Existing members can also reach New organisation from the shell.
- [ ] Implement admin invites/resend/revoke, member role/removal, installation status/retry, typed-slug deletion, and a leave action accessible to members and viewers.
  Show installation verification and profile linking as distinct actions.
- [ ] Invalidate session and membership queries after joining, leaving, role changes, linking, and organisation deletion before navigating.
  Clear private query caches on logout or account switch.
  Update all user labels via Task 2 helper.
- [ ] Remove NotInvited and old GitHub sign-in UI, manual repo form, and login-based invite UI.
  Run `npm test`, `npm run lint`, and `npm run build`; commit and push.

## Task 11: Prove real user journeys and migration compatibility

**Dependencies:** Tasks 1-10.
**Files:** E2E fixtures/onboarding suite/GitHub stub/stack scripts, existing evidence/workflow tests.

- [ ] Use a Node HTTP GitHub stub inside the Compose network with explicit stub configuration injected into API and worker clients.
  Reuse bounded HTTP dependencies for auth endpoints and installation REST calls.
  Never contact real GitHub or Resend during tests.
- [ ] Seed email users and valid memberships without `invited_login`.
  Capture log-mail links by unique recipient and test start time, including URL fragments.
  Do not reuse an older mail when retrying.
- [ ] Add this real-browser assertion before consuming a sign-in token:

```ts
await page.goto(signInLink)
await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
const before = await page.request.get('/api/v1/me')
expect(before.status()).toBe(401)
await page.getByRole('button', { name: 'Sign in' }).click()
await expect(page).toHaveURL(/\/orgs\/new$/)
```

- [ ] Prove signup, organisation creation, invite acceptance in a fresh context, ordinary sign-in followed by accepting a listed invite, multi-org switching, and expired/reused links.
- [ ] Exercise installation return, GitHub user authorization with code/state/PKCE, background repository discovery, then a signed PR webhook on the repo obtained from that flow.
  Do not reseed the repo between setup and webhook assertions.
- [ ] Exercise spoofed and read-only installation attempts, sync retry, repository removal retaining evidence, reconnect, and denied access after member removal.
- [ ] Test an old populated database upgraded through separate `0005` and `0006` stages; null-email and ambiguous-installation upgrades must fail transactionally.
- [ ] Run the complete checks:

```bash
# api/
go test -count=1 ./...
# web/
npm test
npm run lint
npm run build
# e2e/
npx playwright test
```

- [ ] Capture actual results; investigate failures through the real user path.
  Do not erase a non-test volume to make migration tests pass.
  Review, commit, and push the completed integration tests.

## Task 12: Prepare the feature rollout

**Dependencies:** Task 11 and confirmed production foundation deployment before the eventual merge.
**Files:** README, rollout runbook, deploy configuration and obsolete setup scripts.

- [ ] Update README around email confirmation, organisation creation, invitations, GitHub owner verification, repository retention, retries, and profile linking.
  Document App credentials and callback URLs explicitly.
- [ ] Remove obsolete bootstrap, login-invite, and connect-repo scripts only when their replacement flows and tests pass.
  Update their references in setup verification scripts instead of leaving broken invocations.
- [ ] Inspect the final diff and compare every spec section with the coverage map below.
  Check Git identity before committing.
- [ ] Prepare the feature PR with tested behaviors and rollout dependencies.
  Explicitly name the required production backfill, stopped old writers, verified installation mappings, mail configuration, and App configuration.
- [ ] Request approval for the actual production merge/deploy with the validated branch and runbook available.
  Never execute production email updates or delete unclaimed invitations based solely on example values in this plan.

## Coverage map

| Spec | Tasks |
| --- | --- |
| Email identity and confirmation | 2, 3, 5, 10, 11 |
| Organisations, membership, last workspace | 4, 6, 10, 11 |
| Email invitations and personal discovery | 3, 4, 6, 10, 11 |
| GitHub installation and profile authorization | 7, 8, 10, 11 |
| Repo lifecycle, historical evidence, retries | 8, 9, 11 |
| Mail and production validation | 3, 5, 12 |
| Separate-release migration and ownership backfill | 1, 4, 11, 12 |
| APIs, routes, email-only presentation | 2, 5, 6, 7, 8, 10 |
| Transaction, race, replay, and isolation tests | 3 through 11 |
| Operator runbook and removal of obsolete scripts | 1, 12 |

## Planning verification

Review the spec and this plan together.
Search for old token-in-GET contracts, repository DELETE operations, unguarded workspace reassignment, and aggregate row locks.
Verify that the contract migration exists before any test expects membership inserts without `invited_login`.
Do not treat code blocks in this plan as a substitute for tests against the repository.
