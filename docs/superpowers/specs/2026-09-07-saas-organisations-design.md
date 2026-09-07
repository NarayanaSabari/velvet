# Self-Serve Organisations - Design

Date: 2026-09-07
Status: Approved for planning; implementation clarifications recorded below
Builds on: [2026-09-04 Work-Log Ticketing System](2026-09-04-worklog-ticketing-design.md)

## 1. Purpose

Turn the single-team deployment into a product anyone can sign up for.
A person signs in with their email, creates an organisation, invites colleagues by email, and connects GitHub from inside the organisation.
Everything below the organisation - sprints, milestones, issues, comments, evidence, reports - is unchanged.

This is the first of four pieces on the way to a hosted service.
The others are self-serve GitHub at scale, tenant hardening and operations, and billing.
Each gets its own design.

### Non-goals

- Billing, plans, or usage limits.
- Row-level security in Postgres, abuse detection, or rate limiting beyond the sign-in form.
- Notification emails other than invitations and sign-in links.
- Passwords.
- A larger host or managed database.
- A distinct owner role or ownership transfers; admins remain peers.

## 2. Identity

### Email is the account

A user is an email address, trimmed, stored lowercase, unique, and compared case-insensitively.
There are no passwords.
Sign-in is a magic link: the person enters their email, receives a mail, opens a confirmation page, and clicks Sign in to create a session.

The form rejects syntactically invalid addresses with 400 and returns the same 202 response for every valid address, whether it is unknown, known, or rate limited, so it cannot be used to discover accounts.
A new address that completes the link becomes a new user; an existing address signs in to its existing user.
Sign-in requests are limited per address and per client IP.

### Login tokens

A login token is 32 random bytes.
The database stores only its SHA-256 hash, the normalized email it was sent to, the client IP that requested it, an optional invite it was issued for, an expiry 15 minutes after issue, and when it was consumed.
The mail links to `/signin/confirm#token=<token>`.
The fragment keeps the token out of HTTP request logs and referrers.
Loading that page does not consume the token, so mail scanners and link previewers cannot invalidate it with a GET.
Clicking Sign in posts the token to the API, which consumes it and creates the session in one transaction.
A second use, or a use after expiry, shows a "link expired" page with a button to request a new one.

Session cookie attributes and lifetime are unchanged.
Only `session.last_workspace_id` is added; login-token consumption, user creation, invitation acceptance, and session insertion share one transaction.
An invalid invitation rolls back the entire confirmation, and resend revokes the previous invite row so its tied login tokens cannot grant membership.

### GitHub becomes optional on the user

`github_id` and `github_login` on `app_user` become nullable.
They are filled only when the user links their GitHub account from inside an organisation (section 5).
The unique constraints on both remain, so one GitHub account links to at most one user.

## 3. Organisations

An organisation is today's `workspace`, renamed in the interface only.
The table, its slug, and its issue prefix stay as they are.

### Landing after sign-in

A signed-in person with at least one membership goes to their last used organisation, remembered in the session.
If the stored organisation is absent or no longer accessible, use the first membership in deterministic order.
A person with no membership sees one page with two things: a form to create an organisation, and any pending invitations addressed to their email.
The "not invited" page is removed.

### Creating an organisation

The form takes a name, a slug, and an issue prefix.
The slug is suggested from the name and editable.
It matches `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`, is unique across the service, and is not one of: `admin`, `api`, `auth`, `check-email`, `expired`, `invite`, `invites`, `me`, `new`, `orgs`, `settings`, `signin`, `signout`, `w`, or `webhooks`.
The prefix is 2 to 6 uppercase letters.
The creator becomes the organisation's first admin.

### Membership and administration

A membership requires a user; the `invited_login` column and its unique index are dropped.
Users can belong to many organisations.
The shell shows a switcher when there is more than one.

Admins can change a member's role, remove a member, and delete the organisation.
Deletion asks the admin to type the slug, then cascades through the existing foreign keys.
A membership change may never leave an organisation without an admin.
Leaving, removing an admin, and demoting an admin all enforce that invariant in the same transaction as the change.
All membership mutations lock the workspace row first, then recheck the acting user's role before changing membership.
Roles keep their meanings from the original design: admins manage membership, GitHub, and sprints; members create and edit; viewers read.

## 4. Invitations

An admin invites by email address and role.
An invite stores the organisation, the address, the role, the SHA-256 hash of a 32-byte token, who sent it, an expiry seven days out, and when it was accepted or revoked.
One pending invite per address per organisation; inviting again resends with a fresh token.

The mail contains a link to `/invite#token=<token>`, keeping the bearer token out of HTTP request logs and referrers.
The page posts the token to the preview endpoint without consuming it and offers the appropriate action:

- signed in with the same email: Accept creates the membership and lands in the organisation;
- signed in with a different email: a page explains which address the invite was for and offers to sign out;
- signed out: Sign in and accept issues a login token tied to the invite; confirming the mailed sign-in link creates both the session and membership in one transaction.

The Administration page lists pending invites with resend and revoke.
`GET /me/invites` lists the signed-in user's live invitations by normalized email, and the empty landing page lets the user accept one without finding the original mail.
Accepting from that page uses the session identity and the invite id; it never returns or reconstructs the invite token.
Accepting a revoked or expired invite shows the same "expired" page as a dead login link.

The bootstrap and invite shell scripts are removed; their job is done by the sign-up page and the Administration page.

## 5. GitHub as an integration

### Organisation level: installing the App

The GitHub App is changed from "only this account" to public, so any GitHub account or organisation can install it.
Its setup URL points at `/api/v1/github/setup`.
"Redirect on update" is disabled because repository changes arrive through signed webhooks and an update redirect has no live setup state.

An admin clicks Connect GitHub on the Administration page.
The server stores a one-time installation state - 32 random bytes, hashed, tied to the organisation and the admin, expiring in 15 minutes - and redirects to the App's installation page with that state.
GitHub returns to the setup URL with the installation id and the state.
The setup callback verifies the session and state, records the candidate installation id, then starts the GitHub App's user-authorization flow with a second one-time state and PKCE.
The authorization callback exchanges the code for a temporary GitHub user access token and checks that the candidate installation appears in `GET /user/installations` for that token.
Because that list includes installations to which a user has only read access, importing every repository also requires account ownership: a personal installation's account id must match `GET /user`, or an organisation installation must match an active `admin` membership returned by `GET /user/memberships/orgs`.
All paginated authorization results are read completely; an API failure never grants access.
This release supports personal account owners and organisation owners connecting installations; delegated installation managers are deferred.
The user access token is used only for this verification and is never persisted.
After verification the server locks the workspace, rechecks that the user is still an admin, and atomically binds the installation, enqueues a repository-sync job, and completes the setup state.
Each callback state is claimed once for its originating session before code exchange; failed exchanges require a fresh connection attempt and never reuse an OAuth code.
Successful attempts retain a completion receipt until expiry, so a repeated callback from the same session can return its previous result without exchanging the code or granting access again.
The job fetches every granted repository and is safe to retry.

`github_installation` gains a nullable `workspace_id`.
An installation belongs to at most one organisation.
A live organisation has at most one bound installation in this piece; connecting repositories from several GitHub accounts is deferred to self-serve GitHub at scale.
A setup callback for an installation already bound elsewhere fails with a clear message rather than re-binding.
A later verified connection attempt for the same installation and organisation is idempotent and ensures the sync job exists.
Migrated installation bindings require the same owner verification before discovering any additional repositories; historical manual links are not proof of installation-wide authorization.
Until verification succeeds, manual retries, lifecycle events, and scheduled reconciliation preserve existing evidence without importing new repositories.
Repository synchronization refuses any repository row belonging to another organisation, including a disconnected row; it never rewrites that row's workspace id.
The conflict is visible on the Administration page and does not change either organisation's evidence.

From then on the installation events GitHub already delivers keep the repository list current.
`installation_repositories` adds repositories and marks removed repositories disconnected.
Disconnected repositories stop syncing but retain their pull requests, commits, reviews, links, and issue evidence; adding one again reconnects the same row.
`installation` with action `suspend` marks the installation suspended, and `unsuspend` clears it.
`installation` with action `deleted` marks the installation deleted and unbinds it so the organisation can install the App again, while historical repository data remains.
The reconciliation pass skips suspended, deleted, and disconnected records.
Installation lifecycle events enqueue authoritative repository-list reconciliation; only a complete successful listing may disconnect absent repositories.
Queued PR, review, and push events also verify the installation id and active repository state before writing.
Deleting an organisation still deletes its own evidence as requested in section 3; retention applies to loss of GitHub access.

The connect-repo script and the manual repository form are removed.
Repositories come from the installation.
Disconnect GitHub on the Administration page tells the admin to uninstall the App on GitHub and links there; the event does the rest.

### User level: linking a GitHub account

From their profile a member links GitHub through the GitHub App's user-authorization flow with one-time state and PKCE.
The callback stores the GitHub id and login on the signed-in user instead of creating a session.
If that GitHub account is already linked to another user the callback fails with a message and changes nothing.
Unlinking clears both columns.
The temporary GitHub user access token is discarded after the identity is read; linking does not grant Velvet a durable user token.
GitHub installation verification does not implicitly link a profile.
Email-only users display their name when present, otherwise their email, throughout assignee lists, comments, feeds, and reports.
Existing GitHub-handle mentions continue to resolve linked members; a new mention syntax is outside this piece.

Pull request authors are matched to members by GitHub login within the organisation, as the feed and reports already attempt; unmatched authors continue to show as raw GitHub logins.

## 6. Mail

A `mail` package exposes one interface: send a message with a recipient, subject, text body, and HTML body.
Two implementations:

- Resend over HTTPS, used when `RESEND_API_KEY` is set;
- a log mailer that writes the recipient, subject, and every link in the body to the log, used otherwise.

The sign-in and invitation mails use Go text templates for plain text and `html/template` for escaped HTML.
The sender is `MAIL_FROM`, such as `Velvet <noreply@mail.velvet.sabarinarayana.com>`.
The API refuses to start with a `https://` base URL unless both settings are present, so production cannot silently fall back to logging.
The end-to-end suite runs the log mailer and reads links from the API container's log.

## 7. Data model changes

Two migration files are deployed in separate releases.

`0005_organisations.sql` is additive and deploys first:

- `app_user`: add nullable `email text` with a unique index on `lower(email)`; make `github_id` and `github_login` nullable, keeping their unique indexes.
- `login_token`: `id uuid`, `token_hash text UNIQUE`, `email text`, `request_ip text`, `invite_id uuid NULL`, `expires_at`, `consumed_at NULL`, `created_at`.
- `invite`: `id uuid`, `workspace_id`, `email`, `role membership_role`, `token_hash text UNIQUE`, `invited_by uuid`, `expires_at`, `accepted_at NULL`, `revoked_at NULL`, `created_at`; unique on `(workspace_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL`.
- `github_installation`: add `workspace_id uuid NULL REFERENCES workspace ON DELETE SET NULL`.
- `github_setup_state`: add the initial token, workspace, user, and expiry fields.
- `session`: add `last_workspace_id uuid NULL REFERENCES workspace ON DELETE SET NULL`.

After `0005` is deployed, the operator sets the existing production user's email and removes any obsolete unclaimed login-based memberships.

`0006_email_identity.sql` deploys with the feature:

- `app_user.email` becomes `NOT NULL` after asserting that every user was backfilled.
- `membership.user_id` becomes `NOT NULL` after asserting that every membership has a user; `invited_login` and its unique index are dropped; `(workspace_id, user_id)` becomes unique.
- Deleting an invite invalidates its login tokens but retains their issuance rows for rate limiting; `login_token.invite_id` becomes `ON DELETE SET NULL` with invalidation before deletion.
- `repo` gains `disconnected_at timestamptz NULL` so losing GitHub access does not delete historical evidence.
- `github_installation` gains nullable `deleted_at`, `repos_synced_at`, and `ownership_verified_at` timestamps, sanitized `sync_error`, `sync_generation bigint NOT NULL DEFAULT 0`, and a unique partial index on `workspace_id` where it is not null.
  Generation checks prevent stale sync jobs from applying results after lifecycle or binding changes.
- `github_setup_state` gains the candidate installation id and phase needed by the verified two-callback flow.
- `github_authorization_state` stores a hashed one-time state, the user, purpose (`link` or `installation`), an optional setup-state reference, an S256 PKCE verifier, and expiry.

Both GitHub state records also bind to the originating session hash and record their claim/completion state.
The contract migration backfills installation ownership from existing repositories and refuses installations whose repositories span several workspaces, or workspaces with several installations.
Every migrated binding starts with null `ownership_verified_at`; only the verified GitHub owner flow may authorize installation-wide discovery.
Resolve such conflicts explicitly before rollout; do not choose an owner automatically.

The contract migration fails loudly if production was not backfilled.

## 8. API

New or changed endpoints under `/api/v1`:

- `POST /auth/email` - request a sign-in link. Always 202.
- `POST /auth/magic` - body carries the token; consume it, set the cookie, and return the landing destination.
- `GET /me` - the user gains `email`, nullable GitHub fields remain present, and the response gains `last_workspace`.
- `GET /me/invites`, `POST /me/invites/{id}/accept` - list and accept live invitations for the session email.
- `POST /orgs` - create an organisation.
- `DELETE /w/{slug}` - delete, admin only, body carries the slug as confirmation.
- `POST /w/{slug}/leave`.
- `GET|POST /w/{slug}/invites`, `POST /w/{slug}/invites/{id}/resend`, `DELETE /w/{slug}/invites/{id}`.
- `POST /invite/preview` - body carries the token and returns the non-sensitive accept-page details without consuming it.
- `POST /invite/accept` - body carries the token; accept for the matching session or issue a tied login token when signed out.
- `PATCH|DELETE /w/{slug}/memberships/{id}` - role change, removal.
- `GET /w/{slug}/github` - current installation and repository-sync status.
- `POST /w/{slug}/github/sync` - admin-only retry for a verified binding; unverified legacy bindings return `verification_required`.
- `GET /w/{slug}/github/connect` - create state, redirect to GitHub.
- `GET /github/setup` - validate the installation return and start GitHub user authorization.
- `GET /auth/github/callback` - finish installation verification or link the signed-in user, according to the state purpose.
- `GET /auth/github/link` - start profile linking; `DELETE /me/github` - unlink.
- Removed: `POST /w/{slug}/repos`, the GitHub sign-in start and the invite-by-login endpoint.

Errors keep the existing envelope.
Every organisation-scoped handler continues to resolve the membership from the session and the slug, exactly as today.

## 9. Web

New routes: `/signin` becomes the email form; `/signin/confirm`; `/check-email`; `/expired`; `/orgs/new`; `/invite`; `/w/$slug/settings/profile` for GitHub linking.
Removed: `/not-invited`.
The Administration page gains invites, member roles, GitHub connection status, and organisation deletion.
The shell gains the organisation switcher.
The empty organisation page lists pending invitations from `/me/invites` with an Accept action.
Copy uses "organisation" everywhere the interface said "workspace".

## 10. Safety

- Every token - login, invite, installation state, authorization state - is random, hashed at rest, expiring, and single use.
- The email form is limited to 5 requests per normalized address and 20 per client IP in 15 minutes.
- Issuance takes transaction-scoped Postgres advisory locks before counting and inserting, so concurrent requests cannot exceed either limit and the limits hold across processes and restarts.
- Rate-limited sign-in requests still return the same 202 response and send no mail.
- Invite-driven login-token issuance uses the same limits; trusted proxy configuration determines the client IP, never an unchecked forwarded header.
- Deleting invitations or organisations cannot erase recent issuance counters or turn an invitation token into an ordinary sign-in token.
- Browser mutations require a same-origin JSON request; confirmation pages never submit automatically and remove fragments after successful acceptance.
- The magic endpoint relies on a 256-bit single-use token and accepts only POST; it is not separately rate limited.
- Slugs are validated server-side against `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` and the exact reserved list: `admin`, `api`, `auth`, `check-email`, `expired`, `invite`, `invites`, `me`, `new`, `orgs`, `settings`, `signin`, `signout`, `w`, and `webhooks`.
- GitHub installation binding requires both the Velvet admin session and a temporary GitHub user token that can access the returned installation id.
- Linking a GitHub account already linked elsewhere is refused.
- Losing GitHub access changes connection state but never deletes mirrored evidence.
- Organisation-scoped queries are unchanged; the scoping tests extend to invites, installations, setup states, and disconnected repositories.

## 11. Testing

Go, against real Postgres:

- login token issue, POST confirmation, reuse, expiry, and a GET that does not consume;
- rate limit thresholds and concurrent attempts;
- invite issue, accept while signed in, accept while signed out through a tied login token, wrong-email refusal, revoke and expiry;
- current-user invitation listing and acceptance by id without exposing a token;
- organisation create with slug validation and reserved words, delete with confirmation, and last-admin refusal for leave, removal, and demotion, including concurrent changes;
- setup and authorization state issue and consume, wrong-user refusal, spoofed installation refusal, already-bound installation refusal, idempotent retry, and sync-job retry;
- installation event handling adds and disconnects repositories, suspends, unsuspends, and preserves evidence after deletion;
- GitHub link, conflict refusal, unlink;
- scoping leaks across two organisations for every new table.

Playwright, against the Compose stack with the log mailer:

- sign up by magic link through the confirmation button, land on the empty page, create an organisation, see it;
- invite a second address, open the link as that person in a fresh context, land in the organisation as a member;
- see and accept a pending invitation from the empty page without reopening its mail;
- connect GitHub through stubbed installation and user-authorization callbacks, reject a spoofed installation, see the repository appear, receive a signed webhook and see the PR on its issue;
- remove repository access and confirm that its existing PR evidence remains visible.

The CI pipeline is unchanged.
The production rollout deliberately uses the two releases below.

## 12. Operations

Before the additive foundation deploy:

- deploy `0005_organisations.sql` without `0006` or the feature code;
- set the existing admin user's email after `0005` has created the column;
- remove obsolete unclaimed login-based memberships;
- verify the backfill before preparing the feature deploy.

Before the feature deploy:

- a Resend account with the sending domain `mail.velvet.sabarinarayana.com` verified in Cloudflare;
- `RESEND_API_KEY` and `MAIL_FROM` in the host's environment file;
- the GitHub App switched to public with the setup URL and user-authorization callback URL set;
- "Redirect on update" left disabled;
- GitHub App user authorization configured with `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, distinct from the previous OAuth App credentials, and automatic OAuth during installation disabled so the setup URL remains in use;
- `0006_email_identity.sql` included only after the production backfill has been verified.

Mail validation applies to `serve`, not `worker` or `migrate`; Compose must pass mail settings to the API service.
The original OAuth API and worker must be stopped during the contract migration so they cannot write obsolete memberships or email-less users.
Backfill and any deletion of obsolete invitations require an explicit operator-approved target list and a backup.

### Authorization references

GitHub warns that setup URL installation ids are spoofable in [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).
The [installation API](https://docs.github.com/en/rest/apps/installations) includes installations with read access, and the [organisation membership API](https://docs.github.com/en/rest/orgs/members) supplies the role needed to verify ownership.

The README's setup section is rewritten around the sign-up page and the Administration page, and the removed scripts are taken out of it.
