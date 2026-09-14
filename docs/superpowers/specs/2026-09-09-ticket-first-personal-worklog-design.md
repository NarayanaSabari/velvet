# Ticket-First Personal Worklog - Design

Date: 2026-09-09
Status: Approved architecture, pending written-spec review before implementation planning
Builds on: [Work-Log Ticketing System](2026-09-04-worklog-ticketing-design.md) and [Self-Serve Organisations](2026-09-07-saas-organisations-design.md)

The deployed foundation is PR4 (`503434ed53436d8689361fec37a13d1e8cf09939`).
Migration `0005_organisations.sql` is a separate migration artifact from that commit identifier.
The existing PR5 installation and organisation-owner-centric feature (`229f9d6`) is undeployed.
This document corrects the personal-work assumptions in the earlier design without requiring either commit to be merged, reverted, or deleted.
The 2026-09-07 document remains historical for the organisation flow unless this document explicitly says otherwise.

## 1. Product decision

Velvet is a hosted SaaS worklog for one person working across several employer organisations, personal projects, and several GitHub accounts.
Email signup remains the Velvet account identity.
GitHub is an optional read-only integration owned by the Velvet user, not a sign-in requirement and not an organisation installation requirement.

The primary loop is:

`create a Velvet ticket -> write private worklog notes -> optionally attach specific GitHub issues or pull requests -> review the ticket and its evidence`

The first-class record is the Velvet ticket and its journal.
GitHub evidence explains work that the user explicitly chose to attach, but never controls the ticket.

Personal projects, tickets, worklog notes, connections, and imported GitHub evidence are private to their owning Velvet user in this release.
There is no sharing or cross-user project view in this design.

## 2. Scope and user model

### Personal work

A Velvet user may create private personal projects and tickets without belonging to a GitHub organisation or being an organisation administrator.
Tickets cover research, planning, coding, debugging, review, and other work whether or not a GitHub item exists.
Each ticket keeps a user-controlled status, title, description, and ordered private notes.

Worklog notes have a typed purpose of `progress`, `decision`, or `blocker`, plus a Markdown body and timestamps.
Writing a note is a manual journal action and never infers time spent.

Existing organisation tickets remain organisation-scoped and continue to use their existing membership rules.
This personal flow must not require admin access to an employer organisation and must not reinterpret an organisation ticket as a private personal ticket.

### GitHub connection ownership

A Velvet user may have multiple connections, including several GitHub accounts and several credentials for the same account when needed.
Every connection records its owner, provider account identity, authorization method, granted boundary, status, and freshness state.
Every GitHub read is authorized through the selected connection and is checked against that connection's owner.

The current user's `gh` CLI access or access through another tool is not evidence for a Velvet connection.
Each OAuth authorization or PAT supplied to Velvet requires its own user consent and provider access.

## 3. Non-goals

- No local collector, desktop agent, repository clone, filesystem scan, or self-hosted personal integration.
- No GitHub App installation requirement for the personal flow.
- No repository-wide activity feed, repository event import, commit mirroring, code mirroring, diff mirroring, or account-wide data cache.
- No bulk GitHub import, 90-day backfill, account-wide history scan, or unmatched GitHub inbox.
- No automatic creation of Velvet tickets from GitHub data.
- No automatic GitHub-to-ticket matching, AI automatching, or branch/title/body heuristics for personal tickets.
- No automatic ticket status changes, autoclosing, or treating a GitHub state as a Velvet status.
- No time tracking, inferred hours, estimates, or duration inference.
- No GitHub writes, including comments, labels, reactions, issue edits, pull request edits, merges, or installation changes.
- No routine URL-paste workflow requirement; the searchable picker is the primary attachment path.
- No sharing of private projects or imported evidence between Velvet users.
- No billing, plans, quotas, or provider expansion beyond the GitHub connection boundary described here.

## 4. Architecture

The hosted path is browser to Velvet API, Velvet API to Postgres, and a Velvet worker to GitHub REST APIs.
The browser never holds a durable provider secret.
There is no process on the user's workstation that reads repositories or synchronizes data.

The provider boundary has four responsibilities:

1. Authenticate one user-owned connection with OAuth or a fine-grained PAT.
2. Search or list only within that connection's access boundary when the user opens the picker.
3. Read only explicitly attached GitHub issues and pull requests, including their permitted item discussion and reviews.
4. Refresh those attached items in the background while the connection and at least one owner attachment remain active.

The domain boundary has three responsibilities:

1. Create and update private projects, tickets, and journal notes.
2. Record explicit attachment and detachment decisions.
3. Render current ticket state, manual notes, source-labelled GitHub evidence, freshness, and errors without adding unrelated activity.

The worker and queue may reuse the existing durable job mechanism, but every personal job must carry the Velvet user, connection, and approved item scope and recheck them before reading or writing data.

## 5. Domain model and privacy boundary

The eventual schema is owner-scoped rather than a global GitHub mirror.
Names below describe domain records and invariants, not a migration or endpoint contract.

### Personal records

- `personal_project` is owned by one Velvet user and is private by default.
- `personal_ticket` belongs to one personal project and one owner.
- `worklog_note` belongs to one personal ticket and one owner, with a progress, decision, or blocker type.
- Ticket status is stored and changed only by the user through the ordinary ticket flow.

All personal queries must constrain the authenticated owner in SQL and in the service layer.
An ID from another owner must not reveal whether a project, ticket, connection, or GitHub item exists.

### Connections and imported items

- `github_connection` belongs to one Velvet user and stores only encrypted credential material or an encrypted reference to it.
- `github_attachment` joins one owner ticket to one approved GitHub issue or pull request through one connection.
- A ticket may have many attachments.
- The same GitHub item may be attached to many tickets owned by the same user.
- The same GitHub item may be attached by different users, but each owner's representation is separate and is never silently shared through a global repository or item row.
- Owner-scoped item snapshots, discussion entries, and review entries use stable provider IDs for deduplication within that owner and connection boundary.

An attachment is the approval record for future reads.
No sync job may read a repository, issue, pull request, discussion, or review unless an active owner attachment authorizes that item.
The item context includes the selected connection, GitHub account, repository, item type, stable item ID, and source URL.

Each connection and owner-scoped item sync has a synchronization generation or equivalent invalidation fence.
Final owner detach, connection disconnect, and imported-history deletion atomically invalidate the current generation with their relationship, state, or data change.
Those transactions serialize with persistence so a stale provider response cannot recreate deleted data.
Every provider read rechecks the authenticated owner, active connection, active attachment, item scope, and current generation before I/O.
Every persistence transaction rechecks those conditions and performs the write only when the check and write share the same serialization boundary.
An already-authorized provider request may finish after invalidation, but its result must be discarded when the generation no longer matches.
Reconnection or reattachment allocates a new generation and never reuses an old job.
When several owner tickets share an item, detaching one ticket removes that ticket's access immediately, while only the final owner detach stops item sync.

Detaching removes the ticket relationship and invalidates the item generation when no other attachment for the same owner still authorizes it.
Detaching is not an implicit purge of imported data.
Any purge of imported GitHub history is an explicit owner action.

## 6. GitHub authorization

### OAuth App

OAuth App authorization is the primary connection path.
The consent screen explicitly explains that the requested repository permission is broad because private repositories may be involved.
For private repository access this is normally the OAuth App `repo` scope.
Velvet requests that broad permission explicitly, records the granted scope, and treats the granted scope as a ceiling rather than proof of access to every repository.

The application performs only read operations even when an OAuth token technically permits writes.
OAuth App access restrictions on an employer organisation are respected and are never bypassed through another account, an installation, a hidden fallback, or a broader cache.
An organisation member or outside collaborator may need owner approval before Velvet can read that organisation's private resources.

The fact that a user can currently read a private repository through `gh` does not authorize the separate Velvet OAuth application.

### Fine-grained PAT

A fine-grained PAT is an alternative connection method for a user who cannot or does not want to use OAuth.
The user selects the token's resource owner and repositories and obtains any required organisation approval before entering it into Velvet.
Multiple PAT connections per Velvet user are allowed.
Velvet never assumes that one PAT grants access to every employer or personal repository.
The application still performs only read operations regardless of PAT capabilities.

### Credential lifecycle

Provider credentials are encrypted at rest by a server-side key path with a separate lifecycle from ordinary database data.
Tokens and refresh tokens are never written to browser storage, URLs, application logs, job payloads, activity rows, or imported snapshots.
OAuth expiration is tracked and refreshed only when the provider supports refresh for that authorization.
An expired or revoked credential becomes `reauthorization_required` or `revoked` and invalidates its current sync generation until the owner repairs or disconnects it.
Disconnecting a connection atomically marks it inactive and invalidates its current generations, preventing new reads while allowing already-in-flight provider requests to finish and then be discarded by the generation fence.

Disconnect presents a separate explicit choice to retain or delete the connection's imported GitHub history.
Retain preserves the last imported snapshots and source links as stale, read-only evidence.
Delete atomically invalidates the connection generations and removes only that connection's imported GitHub data and connection-scoped attachment records, while keeping the user's projects, tickets, and manual notes.
Any persistence racing with deletion must serialize through the same generation check, so a stale result cannot resurrect deleted data.
Data imported through another owner's connection is unaffected.

## 7. Picker and explicit attachment

The picker is user-invoked and searchable.
The user chooses the GitHub account connection and may filter by repository and item type, with issue and pull request as the supported types.
Queries are paginated and bounded by the selected connection's access boundary.

Picker results are transient request data.
They are not activity rows, not imported evidence, and not a reason to create a ticket.
Closing or abandoning the picker leaves no GitHub activity record.

The user selects an item and explicitly attaches it to an existing Velvet ticket.
Attachment verifies the connection owner, item type, stable provider identity, repository context, and current provider access before creating the relationship.
The operation is idempotent for the same owner, ticket, connection, and item.
It is possible to attach one item to multiple owner tickets through separate explicit actions.

On first attachment, Velvet fetches the item's current metadata and the available history for that item only.
For issues this means item metadata and permitted discussion.
For pull requests this means item metadata, permitted discussion, and permitted reviews.
The fetch is paginated to the provider's reported boundary and is not an account-wide backfill.
Every stored record carries a source label and an outbound GitHub link.

Velvet does not follow references from one issue or pull request to related issues, pull requests, repositories, commits, branches, or events.
No fetched code, patch, repository tree, or commit object is mirrored.
Text written by the user in a private note remains user-authored data and is not treated as fetched code.

## 8. Background sync and freshness

Background sync refreshes only item records that still have an active attachment for the owner, an active authorized connection, and the current synchronization generation.
The worker may deduplicate work for the same owner, connection, and stable item ID, but never across owners or access boundaries.
Invalidation prevents new work, but it cannot promise cancellation of a provider request that was already in flight.
Such a request may finish, but its result must be discarded before persistence if the generation or owner/access state changed.

Each item sync:

- uses the selected connection and rechecks owner, credential status, repository, item type, attachment, and synchronization generation before every provider read and again atomically before persistence;
- follows provider pagination and stores stable issue, pull request, discussion, and review IDs;
- applies newer provider state without allowing an older response to overwrite it;
- honors rate limits, reset information, bounded retries, and provider backoff signals;
- keeps the last known successful state when a later read fails;
- records freshness, the last successful page or update, and a safe error category;
- never writes to GitHub and never infers hours or work duration.

The implementation may choose the worker's cadence and queue partitioning during planning, but it must be freshness-driven, rate-aware, and scoped to attached items.
This document does not prescribe an interval or claim that a sync is complete when a page, permission, or provider response was unavailable.

An item can be shown as current, stale, partial, blocked, revoked, or unavailable.
The UI must distinguish a provider access restriction, authentication failure, rate limit, missing item, and transient error without exposing provider secrets or claiming completeness.
An inaccessible item is not silently deleted and is not replaced by data from another connection.

## 9. Ticket and dashboard behavior

Creating a ticket is always a Velvet action.
The user can create it before connecting GitHub, and it remains useful with no attachment.
Manual updates are added as private progress, decision, or blocker notes.
GitHub evidence is optional and is displayed beside the notes with its source and freshness state.

The personal dashboard shows:

- projects and their tickets;
- ticket status and manual updates;
- explicitly attached GitHub issues and pull requests;
- source links and freshness or access errors;
- a user-selected date filter over tickets, notes, and attached evidence.

The dashboard does not show unrelated GitHub activity, an unmatched inbox, repository-wide events, or a global activity feed assembled from provider data.
GitHub item state may be displayed as evidence, but it never changes the Velvet ticket status.

Detaching an item removes it from the ticket's active evidence and prevents new future sync when no owner ticket still attaches it.
It does not close, delete, or change the ticket.

## 10. Error behavior

The API keeps the existing JSON error envelope and returns safe, owner-neutral messages.
The following behaviors are part of the design:

- OAuth denial or insufficient granted scope leaves the connection unusable for the denied boundary and explains the required user action without retrying with a hidden broader permission.
- Organisation approval restrictions are reported as an organisation access restriction and require approval or another explicitly authorized connection.
- Expired, revoked, or invalid credentials stop connection jobs and require reauthorization or PAT replacement.
- Rate limits and transient provider failures retain the last good item state and schedule bounded retries without marking the item current.
- A missing or inaccessible item is reported as unavailable within that connection and never proves that the item was deleted.
- A stale job that finds no active attachment, a disconnected connection, or an old synchronization generation becomes a no-op and cannot recreate authorization or persist stale data.
- A foreign owner, ticket, connection, or attachment is indistinguishable from not found.
- A GitHub status change, merge, closure, or review never emits a ticket-status mutation.

## 11. Reuse and compatibility audit

The foundation already provides reusable email identity, sessions, organisation membership, workspace authorization, issue/ticket storage, comments, activity primitives, a Postgres-backed job queue, and a hosted API and worker shape.
The personal flow should build beside those primitives where their privacy boundary matches.

The current organisation GitHub path is not a drop-in implementation for this design.
Its `github_installation`, `repo`, `pull_request`, `pr_review`, `commit_ref`, webhook, installation-owner verification, automatic branch/title/body linking, unlinked-PR inbox, and 90-day backfill assumptions are installation-scoped or wider than the approved personal scope.
Those records and existing evidence must be retained for compatibility, but they must not be silently repurposed as owner-private personal data.

The current organisation `activity` stream and public organisation comments are not the private journal.
Picker queries and GitHub refreshes must not be written to that activity stream.
Personal notes require an owner-scoped journal record.

Existing legacy GitHub App installations and imported evidence are not deleted by this feature.
The new connection model does not require installing that App and does not infer personal access from its repositories.
No implementation should force-merge PR5, remove an existing App, or rewrite existing organisation data as part of this design.

## 12. Security invariants

- Email authentication establishes the Velvet user; GitHub authorization establishes only a user-owned integration.
- Every personal read and write is scoped to the authenticated Velvet user, and every GitHub read is additionally scoped to one active connection and one approved attachment.
- Connection credentials are encrypted server-side, redacted from logs and errors, and excluded from browser-visible state and job payloads.
- OAuth scopes and PAT permissions are treated as provider ceilings, not as universal rights.
- Employer organisation restrictions and owner approval requirements are enforced as access boundaries, not as obstacles to bypass.
- The application uses only read methods and does not expose a GitHub mutation path.
- Provider data is source-labelled and linkable, but code, repository trees, diffs, and account-wide activity are not stored.
- Disconnect and deletion affect only the selected owner's connection-scoped data and never delete manual tickets or notes.
- Authorization, attachment, detachment, and deletion mutations use the existing same-origin and session protections.
- Error text, picker results, and timing-sensitive paths must not disclose another owner's data or the existence of an inaccessible private item.

## 13. Validation

Before implementation is accepted, tests should cover the real user flow and the provider boundaries.

### Domain and database

- A member or non-admin can create a personal project, ticket, and note without an organisation admin role.
- Owners cannot read or mutate another owner's project, ticket, note, connection, attachment, or imported item by guessing identifiers.
- One ticket accepts multiple issue and pull request attachments.
- One owner can explicitly attach the same GitHub item to multiple tickets.
- The same item attached by two owners remains two isolated representations.
- Ticket status changes are independent from GitHub state changes.
- Detach stops future sync only after the owner's last attachment is gone.
- Disconnect prevents new connection sync, fences any in-flight result, and retain/delete history choices preserve manual tickets and notes.

### Provider and worker

- OAuth and fine-grained PAT connections retain owner and access-boundary metadata.
- OAuth scope reduction, organisation restrictions, PAT resource-owner limits, expiration, revocation, and refresh behavior fail closed.
- Picker search is on-demand, paginated, filtered by account/repository/type, and leaves no activity row.
- Attachment imports only the selected item's metadata, discussion, and applicable reviews.
- Pagination, stable-ID deduplication, out-of-order responses, rate limits, bounded retries, and partial failures preserve freshness truth.
- No worker request uses a different connection, traverses to related items, mirrors code, or sends a GitHub write.
- Logs and persisted queue payloads contain no access or refresh token.
- A paused worker authorized before provider I/O, then resumed after final detach, disconnect, or history deletion, cannot restore data and cannot affect another owner's data.
- A paused worker resumed after invalidation but before persistence cannot restore data because the persistence transaction rechecks the owner, access state, and generation atomically.
- Reattach or reconnect uses a new generation, and an old job cannot be reused.
- Detaching one of several owner tickets removes that ticket's evidence immediately, while final detach alone stops shared owner-item sync.

### Browser and end-to-end

- A single Velvet user can use connections for three employer organisations and a personal account without becoming an administrator of any employer organisation.
- The flow starts with a ticket and private note, then attaches one PR or issue through the picker, shows the source and freshness, and leaves ticket status unchanged.
- Date filters show project tickets, notes, and attached evidence only.
- Restricted, revoked, stale, and unavailable states are understandable and do not pretend to be complete.
- No local process, repository checkout, GitHub App installation, or URL paste is required.

Tests must use generated credentials and provider stubs.
No real GitHub token, private key, webhook secret, or employer repository data belongs in a fixture.

## 14. Rollout and compatibility principles

This design is additive to the deployed foundation.
Existing organisations, memberships, tickets, comments, activities, GitHub App installations, and imported evidence remain available under their existing ownership rules.
Personal tables and connection records must not rely on a destructive reinterpretation of those rows.

The implementation can introduce the personal path behind a separately controlled product surface and validate it with seeded provider stubs before enabling it for real users.
Any rollout plan must preserve an operator-visible way to stop personal GitHub reads without deleting personal tickets or notes.
Credential disconnect and imported-history deletion remain explicit owner actions.

No deployment commands, environment changes, migration numbers, provider dashboard changes, or production cutover steps are specified here.
Those belong in a later implementation and rollout plan after this spec is reviewed.

## 15. Feasibility references

GitHub documents that OAuth scopes limit token access but do not grant permission beyond the user's existing rights, and that the `repo` scope is broad and includes write-capable repository access.
Velvet therefore needs explicit consent language and an application-level read-only method allowlist.
See [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

GitHub documents that organisation OAuth access restrictions can prevent members and outside collaborators from authorizing an unapproved OAuth App and can require owner approval.
Velvet must surface that boundary and never bypass it.
See [About OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions).

Fine-grained PATs are an alternative because the user can choose a resource owner and repository boundary, subject to GitHub's approval and expiration rules.
See [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## 16. Bounded implementation choices deferred to planning

The next plan may choose table names, endpoint names, queue job names, provider-client package boundaries, encryption-key service, and worker cadence.
Those choices cannot widen the owner, connection, attachment, read-only, privacy, or no-backfill boundaries in this document.

The next plan may choose whether multiple attachments for one owner share one owner-scoped item snapshot or retain per-attachment snapshots.
Either choice must deduplicate stable provider IDs only within the same owner and access boundary and must keep detach, disconnect, and explicit history deletion semantics.

The next plan may choose the exact UI layout and error labels.
It must retain the ticket-first sequence, transient picker results, explicit attachment, source labels, freshness truth, and user-controlled ticket status.

Detailed implementation planning starts only after the user reviews this architecture spec.
