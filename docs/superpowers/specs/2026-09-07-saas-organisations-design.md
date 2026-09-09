# Self-Serve Organisations - Design

Date: 2026-09-07
Status: Approved for planning
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
- Organisation transfer between owners.

## 2. Identity

### Email is the account

A user is an email address, unique and compared case-insensitively.
There are no passwords.
Sign-in is a magic link: the person enters their email, receives a mail, and clicking the link creates a session.

The form returns the same response whether or not the address is known, so it cannot be used to discover accounts.
A new address that completes the link becomes a new user; an existing address signs in to its existing user.
Sign-in requests are limited per address and per client IP.

### Login tokens

A login token is 32 random bytes.
The database stores only its SHA-256 hash, the email it was sent to, an optional invite it was issued for, an expiry 15 minutes after issue, and when it was consumed.
A token is consumed on first use; a second use, or a use after expiry, shows a "link expired" page with a button to request a new one.
Consuming a token creates a session exactly as the OAuth callback does today.

Sessions, their cookie, and their storage are unchanged.

### GitHub becomes optional on the user

`github_id` and `github_login` on `app_user` become nullable.
They are filled only when the user links their GitHub account from inside an organisation (section 5).
The unique constraints on both remain, so one GitHub account links to at most one user.

## 3. Organisations

An organisation is today's `workspace`, renamed in the interface only.
The table, its slug, and its issue prefix stay as they are.

### Landing after sign-in

A signed-in person with at least one membership goes to their last used organisation, remembered in the session.
A person with no membership sees one page with two things: a form to create an organisation, and any pending invitations addressed to their email.
The "not invited" page is removed.

### Creating an organisation

The form takes a name, a slug, and an issue prefix.
The slug is suggested from the name and editable.
It is lowercase letters, digits, and hyphens, 3 to 40 characters, unique across the service, and not one of a reserved list (`admin`, `api`, `auth`, `invite`, `new`, `orgs`, `settings`, `signin`, `w`, `webhooks`, and similar route words).
The prefix is 2 to 6 uppercase letters.
The creator becomes the organisation's first admin.

### Membership and administration

A membership requires a user; the `invited_login` column and its unique index are dropped.
Users can belong to many organisations.
The shell shows a switcher when there is more than one.

Admins can change a member's role, remove a member, and delete the organisation.
Deletion asks the admin to type the slug, then cascades through the existing foreign keys.
A member can leave an organisation unless they are its last admin.
Roles keep their meanings from the original design: admins manage membership, GitHub, and sprints; members create and edit; viewers read.

## 4. Invitations

An admin invites by email address and role.
An invite stores the organisation, the address, the role, the SHA-256 hash of a 32-byte token, who sent it, an expiry seven days out, and when it was accepted or revoked.
One pending invite per address per organisation; inviting again resends with a fresh token.

The mail contains a link to `/invite/<token>`.
Opening it:

- signed in with the same email: the membership is created and the person lands in the organisation;
- signed in with a different email: a page explains which address the invite was for and offers to sign out;
- signed out: the invite's email is used to issue a login token tied to the invite, the person clicks the mailed link, and both the session and the membership are created in one step.

The Administration page lists pending invites with resend and revoke.
Accepting a revoked or expired invite shows the same "expired" page as a dead login link.

The bootstrap and invite shell scripts are removed; their job is done by the sign-up page and the Administration page.

## 5. GitHub as an integration

### Organisation level: installing the App

The GitHub App is changed from "only this account" to public, so any GitHub account or organisation can install it.
Its setup URL points at `/api/v1/github/setup` with "redirect on update" enabled.

An admin clicks Connect GitHub on the Administration page.
The server stores a one-time state - 32 random bytes, hashed, tied to the organisation and the admin, expiring in 15 minutes - and redirects to the App's installation page with that state.
GitHub returns to the setup URL with the installation id and the state.
The server consumes the state, verifies the admin still holds that role, binds the installation to the organisation, fetches every repository the installation grants, and connects them.

`github_installation` gains a nullable `workspace_id`.
An installation belongs to at most one organisation.
A setup callback for an installation already bound elsewhere fails with a clear message rather than re-binding.

From then on the installation events GitHub already delivers keep the repository list current: `installation_repositories` adds and removes repositories, `installation` with action `deleted` or `suspend` marks the installation suspended and its repositories stop syncing.
The reconciliation pass skips suspended installations.

The connect-repo script and the manual repository form are removed.
Repositories come from the installation.
Disconnect GitHub on the Administration page tells the admin to uninstall the App on GitHub and links there; the event does the rest.

### User level: linking a GitHub account

From their profile a member links GitHub through the existing OAuth flow.
The callback stores the GitHub id and login on the signed-in user instead of creating a session.
If that GitHub account is already linked to another user the callback fails with a message and changes nothing.
Unlinking clears both columns.

Pull request authors are matched to members by GitHub login within the organisation, as the feed and reports already attempt; unmatched authors continue to show as raw GitHub logins.

## 6. Mail

A `mail` package exposes one interface: send a message with a recipient, subject, text body, and HTML body.
Two implementations:

- Resend over HTTPS, used when `RESEND_API_KEY` is set;
- a log mailer that writes the recipient, subject, and every link in the body to the log, used otherwise.

Templates are Go text templates for the two mails: sign-in link and invitation.
The sender is `MAIL_FROM`, such as `Velvet <noreply@mail.velvet.sabarinarayana.com>`.
The API refuses to start with a `https://` base URL unless both settings are present, so production cannot silently fall back to logging.
The end-to-end suite runs the log mailer and reads links from the API container's log.

## 7. Data model changes

One migration:

- `app_user`: add `email text NOT NULL` with a unique index on `lower(email)`; make `github_id` and `github_login` nullable, keeping their unique indexes.
- `login_token`: `id uuid`, `token_hash text UNIQUE`, `email text`, `invite_id uuid NULL`, `expires_at`, `consumed_at NULL`, `created_at`.
- `invite`: `id uuid`, `workspace_id`, `email`, `role membership_role`, `token_hash text UNIQUE`, `invited_by uuid`, `expires_at`, `accepted_at NULL`, `revoked_at NULL`, `created_at`; unique on `(workspace_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL`.
- `membership`: `user_id` becomes `NOT NULL`; drop `invited_login` and its unique constraint; unique on `(workspace_id, user_id)`.
- `github_installation`: add `workspace_id uuid NULL REFERENCES workspace ON DELETE SET NULL`.
- `github_setup_state`: `token_hash text PRIMARY KEY`, `workspace_id`, `user_id`, `expires_at`, `created_at`.
- `session`: add `last_workspace_id uuid NULL`.

The existing production user has no email.
Before this deploys, one statement sets it, supplied by the operator.
The migration fails loudly if any user still lacks an email, rather than inventing one.
Existing memberships all have a user, so the `NOT NULL` change is safe; the migration asserts it first.

## 8. API

New or changed endpoints under `/api/v1`:

- `POST /auth/email` - request a sign-in link. Always 202.
- `GET /auth/magic?token=` - consume a login token, set the cookie, redirect into the app.
- `GET /me` - unchanged shape, plus `last_workspace`.
- `POST /orgs` - create an organisation.
- `DELETE /w/{slug}` - delete, admin only, body carries the slug as confirmation.
- `POST /w/{slug}/leave`.
- `GET|POST /w/{slug}/invites`, `POST /w/{slug}/invites/{id}/resend`, `DELETE /w/{slug}/invites/{id}`.
- `GET /invite/{token}` - inspect an invite for the accept page; `POST /invite/{token}/accept`.
- `PATCH|DELETE /w/{slug}/members/{id}` - role change, removal.
- `GET /w/{slug}/github/connect` - create state, redirect to GitHub.
- `GET /github/setup` - installation callback.
- `GET /auth/github/link` and its callback - link the signed-in user; `DELETE /me/github` - unlink.
- Removed: `POST /w/{slug}/repos`, the GitHub sign-in start and the invite-by-login endpoint.

Errors keep the existing envelope.
Every organisation-scoped handler continues to resolve the membership from the session and the slug, exactly as today.

## 9. Web

New routes: `/signin` becomes the email form; `/check-email`; `/expired`; `/orgs/new`; `/invite/$token`; `/w/$slug/settings/profile` for GitHub linking.
Removed: `/not-invited`.
The Administration page gains invites, member roles, GitHub connection status, and organisation deletion.
The shell gains the organisation switcher.
Copy uses "organisation" everywhere the interface said "workspace".

## 10. Safety

- Every token - login, invite, setup state - is random, hashed at rest, expiring, and single use.
- The email form and magic endpoint are limited to 5 requests per address and 20 per IP in 15 minutes, enforced in Postgres so it holds across restarts.
- Slugs are validated server-side against the pattern and the reserved list.
- The setup callback checks that the state belongs to the calling admin's session, so a leaked state URL cannot bind an installation to a stranger's organisation.
- Linking a GitHub account already linked elsewhere is refused.
- Organisation-scoped queries are unchanged; the scoping tests extend to invites, installations, and states.

## 11. Testing

Go, against real Postgres:

- login token issue, consume, reuse, and expiry;
- rate limit thresholds;
- invite issue, accept while signed in, accept while signed out through a tied login token, wrong-email refusal, revoke and expiry;
- organisation create with slug validation and reserved words, delete with confirmation, leave as last admin refused;
- setup state issue and consume, wrong-user refusal, already-bound installation refusal;
- installation event handling adds, removes, and suspends repositories;
- GitHub link, conflict refusal, unlink;
- scoping leaks across two organisations for every new table.

Playwright, against the Compose stack with the log mailer:

- sign up by magic link, land on the empty page, create an organisation, see it;
- invite a second address, open the link as that person in a fresh context, land in the organisation as a member;
- connect GitHub through a stubbed setup callback, see the repository appear, receive a signed webhook and see the PR on its issue.

The CI pipeline and deployment are unchanged.

## 12. Operations

Before the first deploy of this piece:

- a Resend account with the sending domain `mail.velvet.sabarinarayana.com` verified in Cloudflare;
- `RESEND_API_KEY` and `MAIL_FROM` in the host's environment file;
- the GitHub App switched to public with the setup URL set;
- the existing admin user's email set by the operator.

The README's setup section is rewritten around the sign-up page and the Administration page, and the removed scripts are taken out of it.
