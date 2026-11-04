# api

## Overview
HTTP layer. `Server` owns the route mux, middleware, JSON responses and the activity stream broker.

## Interface
- `type Server`, `type Dependencies`, `func NewServer(pool *pgxpool.Pool, cfg *config.Config, deps Dependencies) *Server`
- [Dependencies](server.go) supplies `Mailer`, `GitHubUser`, and `CompleteGitHubInstallation`. The completion callback must bind the installation, enqueue synchronization, and complete both authorization states in one transaction using the store's workspace/admin and state locks.
- `func (s *Server) Handler() http.Handler`
- `type Broker`, `func NewBroker() *Broker` with `Subscribe`, `Publish`, `Refresh` per workspace
- `WriteJSON`, `WriteError` response helpers
- Concrete HTTP interfaces are inventoried below, with links to the handlers defining JSON fields and response shapes.

### Exported helpers and middleware
- [CurrentUser(ctx)](auth.go) returns `(store.User, bool)` from authenticated request context.
- [CurrentWorkspace(ctx)](auth.go) returns `(store.Membership, bool)` from workspace-resolved request context.
- [(*Server).RequireAuth(next)](auth.go) authenticates bearer or session cookie and enforces token scope. An explicit bearer credential never falls back to the cookie.
- [(*Server).RequireWorkspace(next)](auth.go) authenticates, resolves `{slug}` to current membership, enforces scope, and remembers the workspace for cookie sessions on the first successful response. Missing membership returns 404.
- [RequireRole(roles...)](auth.go) returns middleware requiring one of the given current workspace roles, otherwise 403.
- [RequestID(next)](middleware.go) reuses `X-Request-Id` or generates a UUID, storing it in context and the response header.
- [Logging(next)](middleware.go) logs method, path, response status, elapsed milliseconds and request ID.
- [Recover(next)](middleware.go) logs panics and sends a generic 500 error without returning the panic value.
- [WriteJSON(w, status, value)](respond.go) writes JSON content type/status and encodes non-nil values. `WriteError(w, status, code, message)` uses `ErrorResponse{Error: ErrorBody{Code, Message}}`, serialized as `{"error":{"code":"...","message":"..."}}`.
- [DecodeJSON(w, r, dst)](respond.go) returns false after a 400 `invalid_request` on decode failure. It rejects unknown fields and reads through a 1 MiB `LimitReader`; it decodes one value, not an independently enforced whole-body/trailing-value check.
- [RenderWorklogMarkdown(entries)](worklog.go) returns a worklog grouped by day then organisation, including an explicit empty-period message.
- [Broker.Subscribe(workspaceID)](stream.go) returns a buffered event channel and idempotent unsubscribe callback. `Publish` sends activity and `Refresh` sends an invalidation signal; slow subscribers may miss events rather than blocking publishers.

### Concrete HTTP route inventory
All paths below are literal route patterns. Workspace routes require current membership and token-scope checks; mutation roles and browser-only restrictions remain in the linked registration/handler source, not implied merely by the verb.

#### Public and account routes
- [server.go](server.go): `GET /api/v1/health` probes the database; `POST /webhooks/github` accepts signed webhook deliveries.
- [auth.go](auth.go), [email_auth.go](email_auth.go): `POST /api/v1/auth/email` requests an email sign-in link; `POST /api/v1/auth/magic` confirms it; `GET /api/v1/auth/magic` deliberately returns 405 with `Allow: POST`; `POST /api/v1/auth/logout` ends a browser session and clears its cookie; `GET /api/v1/me` returns identity, memberships, token kind and applicable scope.
- [api_token.go](api_token.go): `GET /api/v1/me/tokens` lists metadata; `POST /api/v1/me/tokens` creates a named personal token; `DELETE /api/v1/me/tokens/{id}` revokes an owned token; `DELETE /api/v1/me/token` revokes the bearer credential used for the request.
- [org.go](org.go): `POST /api/v1/orgs` creates an organisation; `PATCH /api/v1/w/{slug}` renames it; `DELETE /api/v1/w/{slug}` deletes it with slug confirmation; `POST /api/v1/w/{slug}/leave` leaves it.
- [onboarding.go](onboarding.go): `GET /api/v1/me/onboarding` returns setup progress/defaults; `POST /api/v1/me/onboarding/organisation` creates the initial organisation.
- [invite.go](invite.go): `GET /api/v1/me/invites` lists email-matching invitations; `POST /api/v1/me/invites/{id}/accept` accepts by ID; `POST /api/v1/invite/preview` previews a token; `POST /api/v1/invite/accept` accepts a token or starts email confirmation for a signed-out caller.
- [invite.go](invite.go): `GET /api/v1/w/{slug}/invites` lists live invitations; `POST /api/v1/w/{slug}/invites` issues one; `POST /api/v1/w/{slug}/invites/{id}/resend` replaces it; `DELETE /api/v1/w/{slug}/invites/{id}` revokes it.
- [membership.go](membership.go): `GET /api/v1/w/{slug}/members` returns people choices; `GET /api/v1/w/{slug}/memberships` returns administrative records; `PATCH /api/v1/w/{slug}/memberships/{id}` changes a role; `DELETE /api/v1/w/{slug}/memberships/{id}` removes a member.

#### Planning and issue routes
- [project.go](project.go): `GET /api/v1/w/{slug}/projects` lists projects; `POST /api/v1/w/{slug}/projects` creates one; `GET /api/v1/w/{slug}/projects/{key}` reads one; `PATCH /api/v1/w/{slug}/projects/{key}` patches one; `PUT /api/v1/w/{slug}/repos/{id}/project` assigns/clears repository project mapping.
- [sprint.go](sprint.go): `GET /api/v1/w/{slug}/sprints` lists sprints; `POST /api/v1/w/{slug}/sprints` creates one; `GET /api/v1/w/{slug}/sprints/{id}` reads one; `PATCH /api/v1/w/{slug}/sprints/{id}` patches it; `POST /api/v1/w/{slug}/sprints/{id}/activate` activates it; `POST /api/v1/w/{slug}/sprints/{id}/close` closes it; `GET /api/v1/w/{slug}/sprints/{id}/snapshot` reads its frozen report.
- [milestone.go](milestone.go): `GET /api/v1/w/{slug}/sprints/{sprintID}/milestones` lists a sprint's milestones; `GET /api/v1/w/{slug}/milestones` lists filing choices; `POST /api/v1/w/{slug}/sprints/{sprintID}/milestones` creates one; `GET /api/v1/w/{slug}/milestones/{id}` reads one; `PATCH /api/v1/w/{slug}/milestones/{id}` patches it.
- [issue.go](issue.go): `GET /api/v1/w/{slug}/issues` filters/pages issues; `POST /api/v1/w/{slug}/issues` creates one; `GET /api/v1/w/{slug}/issues/{key}` reads detail; `PATCH /api/v1/w/{slug}/issues/{key}` patches it.
- [label.go](label.go): `GET /api/v1/w/{slug}/labels` lists labels; `POST /api/v1/w/{slug}/labels` creates one; `DELETE /api/v1/w/{slug}/labels/{id}` removes it; `PUT /api/v1/w/{slug}/issues/{key}/labels` replaces an issue's label set.
- [comment.go](comment.go): `GET` and `POST` on each of `/api/v1/w/{slug}/issues/{key}/comments`, `/api/v1/w/{slug}/milestones/{id}/comments`, `/api/v1/w/{slug}/projects/{key}/comments` list/create target comments. `PATCH /api/v1/w/{slug}/comments/{id}` edits, `DELETE /api/v1/w/{slug}/comments/{id}` soft-deletes, and `POST /api/v1/w/{slug}/comments/{id}/promote` promotes a project log entry. `GET /api/v1/w/{slug}/mentions` lists mentions; `POST /api/v1/w/{slug}/mentions/read` marks them read.
- [image.go](image.go): `GET` and `POST` on each of `/api/v1/w/{slug}/issues/{key}/images`, `/api/v1/w/{slug}/milestones/{id}/images` list/upload images; `GET /api/v1/w/{slug}/images/{id}/content` serves bytes, with `?download=1` for download; `DELETE /api/v1/w/{slug}/images/{id}` removes one.

#### Activity, evidence, provider and report routes
- [activity.go](activity.go), [stream.go](stream.go): `GET /api/v1/w/{slug}/activity` pages the feed; `GET /api/v1/w/{slug}/dashboard` returns personal dashboard data; `GET /api/v1/w/{slug}/stream` opens SSE activity/refresh events.
- [github.go](github.go): `GET /api/v1/w/{slug}/issues/{key}/evidence` reads evidence; `POST /api/v1/w/{slug}/issues/{key}/evidence` attaches a reference; `POST /api/v1/w/{slug}/issues/{key}/prs` manually links a PR; `DELETE /api/v1/w/{slug}/issues/{key}/prs/{prID}` unlinks it; `GET /api/v1/w/{slug}/pull-requests/unlinked` lists unmatched PRs; `GET /api/v1/w/{slug}/repos` lists repositories; `GET /api/v1/w/{slug}/github` reads installation status; `GET /api/v1/w/{slug}/github/connect` starts admin installation consent; `POST /api/v1/w/{slug}/github/sync` requests refresh.
- [github_link.go](github_link.go): `GET /api/v1/auth/github/link` starts profile OAuth; `GET /api/v1/auth/github/callback` handles OAuth return; `GET /api/v1/github/setup` handles installation return; `DELETE /api/v1/me/github` unlinks the global account. `GET /api/v1/w/{slug}/me/github` reads effective identity; `GET /api/v1/w/{slug}/me/github/link` starts organisation-specific linking; `DELETE /api/v1/w/{slug}/me/github` unlinks that override.
- [suggestion.go](suggestion.go): `GET /api/v1/w/{slug}/suggestions/notes` lists note suggestions; `POST /api/v1/w/{slug}/suggestions/{id}/accept` accepts one; `POST /api/v1/w/{slug}/suggestions/{id}/dismiss` dismisses one; `GET /api/v1/w/{slug}/suggestions/settings` reads settings; `PATCH /api/v1/w/{slug}/suggestions/settings` changes them.
- [report.go](report.go): `GET /api/v1/w/{slug}/reports/activity`, `GET /api/v1/w/{slug}/reports/milestones`, `GET /api/v1/w/{slug}/reports/closed`, `GET /api/v1/w/{slug}/reports/stale` return person activity, milestone completion, closed-issue counts and stale work respectively.
- [worklog.go](worklog.go): `GET /api/v1/me/worklog`, `GET /api/v1/me/worklog.md`, `POST /api/v1/me/resolve-repo` expose recap and repository resolution, detailed below.
- [cli_auth.go](cli_auth.go): `POST /api/v1/cli/sessions`, `POST /api/v1/cli/sessions/token`, `GET /api/v1/cli/sessions/{code}`, `POST /api/v1/cli/sessions/{code}/approve`, `POST /api/v1/cli/sessions/{code}/deny`, `POST /api/v1/cli/project-tokens` expose consent and issuance, detailed below.

### Device consent and grant results
Source: [HTTP handlers](cli_auth.go), [session/grant structs and transactions](../store/cli_session.go), [token allowlists](token_scope.go).

- Creation accepts `{"client_name":"...","flow":"init|login|manage|desktop"}`; omitted/empty flow defaults to `init`, unknown flow returns 400. A 201 response contains `device_code`, formatted `user_code`, `verification_uri`, `verification_uri_complete`, `expires_at`, and polling `interval: 2` seconds. Sessions expire after ten minutes. The device secret stays with the initiating client; the browser approves using the short user code.
- Browser GET returns `flow`, `id`, `user_code`, `client_name`, `status`, `expires_at` only for pending/unexpired sessions, otherwise 404. GET/approve/deny require a signed-in cookie session, never an API token. Successful approve or deny returns 204; stale/used codes return 404.
- `init` approval accepts `workspace_slug` and `project_key`, requires admin/member access and a project belonging to that organisation. Collection rechecks writer access and active project. It grants `kind: "project"` with `token`, workspace slug/name, issue prefix, project key/name and role.
- `login`, `manage`, and `desktop` approval accepts an empty object and rejects nonempty workspace/project selection with 400. Collection grants `kind: "setup"`, `"personal"`, or `"desktop"` respectively, with `token`, without selected workspace/project. Setup is a machine setup credential, personal is management access, and desktop access follows current membership roles subject to the token allowlist.
- Polling accepts `{"device_code":"..."}` without a cookie and returns 200 with a one-time `CLIGrant`, 202 `authorization_pending`, 403 `access_denied`, 410 `expired_token` (including unknown or already collected secrets), or 409 `token_limit`. Blank device code returns 400. Minting and marking collected share a transaction; raw credentials are not stored. Successful creation and browser lookup set `Cache-Control: no-store`; polling sets it after JSON decoding, before grant-result handling. Earlier middleware, authentication, decoding, or lookup failures may return without that header.
- Project issuance accepts `{"workspace_slug":"...","project_key":"..."}` from a setup bearer credential only. It requires current admin/member access to an active project and returns 200 with `kind`, `token`, workspace/project metadata, role, and `scope: {workspace_slug, project_key}`. Reissuing rotates an existing child secret rather than growing quota. Failures include 400 missing fields, 403 wrong credential/access, 404 inaccessible active project, 409 token limit. Successful issuance sets `no-store`; earlier failures may not.

### Comment, mention, recap and resolution contracts
- [Comment creation](comment.go) takes nonblank `body`, optional `parent_id` and optional `kind` (`progress|decision|blocker|note`); returns the created comment with 201. Source (`human|agent`) and API-token attribution derive from authentication, never payload. Listing returns `{"comments":[...]}`. PATCH takes nonblank `body` and returns the updated comment; DELETE returns 204. Replies nest at most one level. Editing is author-only; deletion also permits admins, as enforced in [store/comment.go](../store/comment.go).
- [Promotion](comment.go) takes a trimmed, nonblank `title` and returns the new issue with 201. Only a project work-log entry is promotable, otherwise 400. [The store](../store/comment.go) retains the original entry and links it to the new ticket.
- [Mentions](comment.go) returns `{"mentions":[...]}`, with `unread=true` for unread-only and the shared project filter. Mark-read accepts `{"comment_ids":["UUID",...]}`; an empty body or empty list marks all within scope. Invalid UUIDs return 400; success returns 204.
- [Recap](worklog.go) accepts `from`, `to` (`YYYY-MM-DD`), `workspace`, `project`, positive `limit`, and positive `days`. `days` overrides the date range. [Store defaults](../store/worklog.go) use seven days including today, limit 500, capped at 2000. Invalid windows return 400. Only the caller's work in current memberships appears; project keys can recap only their own workspace/project and conflicting filters return 403.
- JSON recap returns `{"entries":[...]}`; Markdown returns the same entries rendered with `Content-Type: text/markdown; charset=utf-8`. Both successful recap responses set `no-store`; earlier validation, authentication, or read errors may not. [WorklogEntry](../store/worklog.go) identifies day/time, workspace, optional project/issue, kind (`note|issue|pull_request|commit`), title/body/URL/status and note attribution where present.
- [Repository resolution](worklog.go) takes nonblank `remote` and returns [RepoResolution](../store/resolve.go): workspace slug/name, repository owner/name, issue prefix, and nullable project key/name, on success, with `no-store`; earlier failures may not set that header. Only caller memberships participate. No match returns 404, multiple matches 409 `ambiguous`, and missing remote 400.

## Invariants
- Unknown paths return `404 not_found` JSON.
- `/webhooks/github` is outside `/api/v1` and unauthenticated by session. It requires a valid `X-Hub-Signature-256` HMAC from `GITHUB_WEBHOOK_SECRET`.
- [Browser mutation security](browser_security.go) exempts GET, HEAD, OPTIONS, `/webhooks/github`, explicit bearer requests, and the two POST device endpoints `/api/v1/cli/sessions` and `/api/v1/cli/sessions/token`. Other requests require exactly one canonical `Origin` matching `BASE_URL` and `application/json`; only supported image-upload POSTs may use `multipart/form-data`. Bearer/device exemptions skip both Origin and browser content-type checks, not handler authentication/validation.
- Agent tokens are limited by `token_scope.go`.
- Health returns `503 unavailable` when the database ping fails.

## Side Effects
- Reads and writes Postgres through `store`.
- Sends mail through `mail.Mailer`.
- Calls GitHub through `github.UserClient`.
- Holds open streaming responses for workspace activity.

## Verification
- Run: `cd api && go test ./internal/api/...`
