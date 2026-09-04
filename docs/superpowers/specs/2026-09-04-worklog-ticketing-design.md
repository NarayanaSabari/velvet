# Work-Log Ticketing System - Design

Date: 2026-09-04
Status: Approved for planning

## 1. Purpose

A self-hosted ticketing and work-log system for a small team (2-10 people).
Work is organised as monthly sprints containing milestones containing issues.
The issues a person worked on, together with the comments they wrote, are the record of work done.
GitHub pull requests are attached to issues as proof of that work, not as a controller of it.

Linear is the reference for feel and speed, not for feature scope.
Self-hosting is a requirement: the team owns the data and the deployment.

### Non-goals

- Time tracking, timers, or duration entry.
- Story points or estimates.
- Custom per-workspace status workflows.
- Automatic status transitions driven by GitHub.
- Cycle-time and throughput analytics (deferred, see section 8).
- Multi-tenancy as a product feature (the schema is prepared for it; the product is not).

## 2. Users and access

Members sign in with GitHub OAuth.
There are no passwords, because every member already has a GitHub account and a second credential store is a liability without a benefit.

A GitHub login must be invited to the workspace before it can sign in.
A stranger who discovers the URL sees a "not invited" page rather than an account.

Roles are `admin`, `member`, and `viewer`.
Admins manage membership, repo connections, and sprint lifecycle.
Members create and edit issues, comment, and attach PRs.
Viewers read.

Two GitHub identities are used deliberately and kept separate:

- A **GitHub App** installed on the organisation owns webhooks and repository reads, authenticating with short-lived installation tokens.
- **OAuth** answers only the question "which human is this".

App permissions survive any one person leaving the team, whereas a personal access token dies with its owner.

## 3. Architecture

Monorepo with `/api` (Go), `/web` (React SPA), and `/deploy` (Compose files).

```
Browser ──> Caddy ──> web (static SPA build)
                 └──> api (Go HTTP)
GitHub  ──> Caddy ──> api /webhooks/github

api ──> Postgres, Redis
worker <── Redis, ──> Postgres, ──> GitHub REST
```

Five containers: `caddy`, `api`, `worker`, `postgres`, `redis`.
Caddy terminates TLS with Let's Encrypt, serves the built SPA, and proxies `/api` and `/webhooks`.

### One binary, two entrypoints

`ticket serve` runs the HTTP API; `ticket worker` runs the queue consumer.
The same code and the same models back both, so the two can never drift apart, but they scale and fail independently.

The webhook handler verifies the HMAC signature, writes the raw payload to `github_events`, enqueues a job, and returns 200 in single-digit milliseconds.
All real work happens in the worker, where a slow GitHub call cannot cause GitHub to mark the endpoint unhealthy.
Deliveries are deduplicated on delivery ID, so GitHub's retries are safe.

### API

REST over JSON under `/api/v1`, cursor-paginated lists.
A generated OpenAPI spec produces the TypeScript client for the SPA, which recovers most of the shared-types benefit of a single-language stack.

Sessions live in an HttpOnly, SameSite=Lax cookie; the SPA never holds a token.

Realtime updates use SSE at `/api/v1/stream`, not WebSockets: updates are server-to-client only, and SSE traverses proxies with far less trouble.

## 4. Data model

```
workspace ─┬─ membership ── user
           ├─ sprint ── milestone ── issue ─┬─ issue (sub, one level)
           │                                 ├─ pr_link ── pull_request ── repo
           │                                 └─ comment
           ├─ label
           ├─ repo
           └─ activity
```

Every table below `workspace` carries `workspace_id`, and every query filters on it.
There is one tenant today; the column costs nothing now and is agony to retrofit later.

### Hierarchy

`sprint` is a calendar month: name, start date, end date, state (`upcoming`, `active`, `completed`).

`milestone` belongs to a sprint: name, description, owner, target date, status.

`issue` belongs to a milestone, or to no milestone at all.
The unfiled backlog is deliberate: work arrives before anyone has filed it under a goal, and requiring a milestone at creation makes people skip logging entirely.

Sub-issues are `parent_id` self-references limited to **one level**.
Arbitrary nesting turns every rollup into a recursive query for a structure teams rarely use past depth two.

### Issue

Fields: human-readable key (`ENG-142`, from a per-workspace counter) plus a UUID primary key, title, Markdown description, `status`, `priority` (0-4), `assignee_id`, `milestone_id`, `parent_id`, `position`.

`status` is a fixed enum: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`.
It is not user-configurable, so that a status means the same thing across every issue in every report.

`position` is a fractional index string, so dragging a card between two others writes exactly one row instead of renumbering a column.

No estimates and no points: this is a record of work, not a planning-poker tool.

Labels are workspace-scoped (name, colour) and joined to issues through `issue_label`, allowing many labels per issue.

### Comment - the progress log

One `comment` table with a polymorphic target: `target_type` (`issue` or `milestone`) and `target_id`, plus Markdown body, author, created and edited timestamps, and soft delete.

Threading is one level deep: a comment may reply to a comment, no further.

Milestone comments carry the periodic narrative ("here is where this stands").
Issue comments carry the detail.

`@mentions` are parsed on write into `comment_mention`, so notifications and a "mentions of me" view never require scanning every body.

### Activity - the single stream

Append-only, one row per meaningful action:
`(id, workspace_id, actor_id, verb, target_type, target_id, metadata jsonb, created_at)`.

Verbs: `commented`, `created_issue`, `changed_status`, `assigned`, `attached_pr`, `completed_milestone`, `closed_sprint`.

Every row is written in the same transaction as the change it describes, so the feed can never disagree with the underlying data.

This table is denormalised on purpose.
"My recent updates" and "the team's recent updates" are the two most-loaded screens in the product, and both reduce to a single indexed scan rather than a union of joins across comments, status events, and PR links.

Indexes: `(workspace_id, created_at desc)` for the team feed, `(actor_id, created_at desc)` for the personal feed.

### GitHub tables

`repo` links a workspace to a GitHub repository and records the installation.

`pull_request` mirrors GitHub state: number, title, state, draft flag, author, additions, deletions, `merged_at`, timestamps.

`pr_link` joins a pull request to an issue, with `link_source` of `branch`, `body`, or `manual`.
The relationship is many-to-many: one PR can serve two issues, and one issue can need three PRs.

`github_events` stores raw webhook payloads keyed by delivery ID for deduplication and replay.

### Sprint close

Closing a sprint freezes a `sprint_snapshot`: milestones completed against planned, issue counts per status, and per-person activity totals.
Frozen at close, so later edits cannot silently rewrite last month's report.
Incomplete issues move to the next sprint.

## 5. GitHub integration

### Linking

The worker attempts, in order, stopping at the first match:

1. **Branch name** containing an issue key, e.g. `sabari/eng-142-fix-auth`. Works from the moment the branch exists.
2. **PR title or body** containing an issue key, e.g. `ENG-142`.
3. **Manual attachment** from the issue page.

A PR that matches nothing is still stored and appears in an **Unlinked PRs** view.
Silently dropping unmatched work is how a team stops trusting the tool, so the gap stays visible and one click closes it.

### Evidence, not automation

An attached PR renders on the issue as an evidence card: state, title, author, additions and deletions, merge date, and a link out.
Attaching writes one `attached_pr` activity row.

Attaching or merging a PR **never changes issue status**.
On merge, the assignee is prompted: "PR merged - is ENG-142 done?"
A prompt, never a transition, because the record should reflect what the person decided rather than what a branch name implied.

Commits pushed to a linked branch and reviews left on a linked PR are also mirrored onto the issue timeline.
Without reviews, the record would only ever credit authors.

### Webhooks and reliability

Subscribed events: `pull_request`, `pull_request_review`, `push`, `installation`, `installation_repositories`.

Webhooks are missed in practice - server restarts, GitHub incidents, exhausted retries.
Therefore an hourly job re-fetches PRs updated since each repo's last successful sync, and a nightly pass covers all open PRs.
A system whose correctness depends on never missing a webhook is quietly wrong within a month.

Installation tokens allow 5,000 requests per hour.
Conditional requests with ETags make unchanged PRs free, a shared limiter bounds worker concurrency, and 403 responses back off until the reset header allows retry.

### Onboarding a repository

Install the GitHub App on the organisation, choose which repositories map to the workspace, then backfill the last 90 days of pull requests so the views are not empty on day one.

## 6. Views

**My Dashboard** - the signed-in user's activity feed, their open issues grouped by milestone, unread mentions, and the current sprint's milestones with their share of them.

**Team Feed** - the same stream unfiltered, filterable by person, milestone, or verb. The "what did everyone do this week" screen.

**Sprint view** - the month's milestones as rows, each showing issues by status, the owner, and the most recent comment.
The latest comment is shown because it carries more information than the counts: a milestone at three of eight issues whose last update reads "blocked on vendor access" is understood, and one silent for two weeks is not.

**Milestone page** - description, its issues, and the comment thread read as a narrative log.

**Issue page** - description, a unified timeline of comments, status changes, commits, PRs and reviews, plus evidence cards.

**Unlinked PRs** - pull requests with no matching issue, with one-click attach.

## 7. Reports

Deliberately small:

- Per-person activity counts over a period.
- Milestone completion rate per sprint.
- Issues closed per sprint.
- Staleness: issues `in_progress` with no comment or PR activity in N days.

Staleness is the one expected to earn its keep, because it surfaces work that quietly stopped.

## 8. Deferred

Cycle-time and throughput analytics.
Status here is human-entered, so those numbers would measure logging discipline rather than delivery speed, and a metric that measures the wrong thing is worse than no metric.
Revisit if status entry proves consistently prompt.

Also deferred: estimates, custom workflows, multiple workspaces as a user-facing feature, and notification channels beyond in-app and email digest.

## 9. Testing

Go domain logic covered by table-driven unit tests.

Integration tests run against a real Postgres via testcontainers, not a mocked database: the bugs that actually occur here are tenant-scoping leaks and ordering errors, and both only appear against real SQL.

Webhook processing is tested by replaying captured GitHub fixture payloads, including duplicate deliveries and out-of-order arrivals.

The SPA uses Vitest for units and a small Playwright suite over the paths that matter: sign in, create issue, comment, attach a PR, close a sprint.

## 10. Delivery

`docker compose up` on a VPS, with `caddy`, `api`, `worker`, `postgres`, and `redis`.

Migrations are versioned and applied on boot in a single-writer step.

A nightly `pg_dump` ships to object storage.

GitHub Actions runs tests and builds images; deployment is a pull and a restart.

Secrets - GitHub App private key, webhook secret, OAuth client secret, database URL - are supplied through the environment and never committed.
