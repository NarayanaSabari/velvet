# db

## Overview
Postgres connection and embedded schema migrations.

## Interface
- `func Connect(ctx context.Context, url string) (*pgxpool.Pool, error)`
- `func Migrate(ctx context.Context, pool *pgxpool.Pool) error`
- `migrations/*.sql`: embedded with `//go:embed`, files `0001_init.sql` to `0020_repo_scoped_commits.sql`.

## Invariants
- [Connect](db.go) parses the URL, overrides `MaxConns` to 10 and `MaxConnLifetime` to one hour, then immediately pings. A failed ping closes the new pool and returns an error.
- Migrations apply once each, in filename order, tracked in `schema_migration`.
- `Migrate` holds `pg_advisory_lock(4242)` so concurrent containers never apply one migration twice.
- New migrations take the next number. Applied files must not change.
- [0001](migrations/0001_init.sql) defines issue statuses `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`, priority `0..4`, and unique `(workspace_id, key)`. Its issue-depth trigger forbids self-parenting, grandchildren, and making an issue with children into a child.
- [0001](migrations/0001_init.sql) defines membership roles `admin|member|viewer`, sprint states `upcoming|active|completed`, milestone statuses `planned|in_progress|completed|cancelled`, ordered sprint dates, and one-level comment replies.
- [0011](migrations/0011_sprint_project.sql) makes each sprint belong to a project and replaces the workspace-wide active index with one active sprint per project.
- [0019](migrations/0019_desktop_auth.sql) restricts CLI flows to `init|login|manage|desktop`. API-token kinds `personal|setup|desktop` require NULL project and parent IDs; `project` requires a non-NULL project ID.
- [0020](migrations/0020_repo_scoped_commits.sql) keys commit evidence by `(repo_id, sha)`, preserving the same SHA independently in different repositories.
- [0002](migrations/0002_github.sql) defines PR states `open|closed|merged`, unique `(repo_id, number)` PRs, unique `(pull_request_id, issue_id)` links, provider-unique repository/review IDs, and delivery-ID webhook deduplication. Link sources are `branch|body|manual`, extended with `suggested` by [0013](migrations/0013_link_suggestions.sql).
- [0005](migrations/0005_organisations.sql) enforces case-insensitive email identity and one unaccepted/unrevoked invitation per workspace/email, even if expired. [0006](migrations/0006_email_identity.sql) requires non-NULL email/user membership, unique workspace/user membership, and at most one bound installation per workspace. Invite deletion marks related login tokens consumed before their invite reference becomes NULL.
- [0006](migrations/0006_email_identity.sql) restricts setup phases to `installation|authorization|completed`, authorization purposes to `link|installation`, and requires a setup reference exactly for installation authorization. [0010](migrations/0010_membership_github_identity.sql) permits `link_workspace_id` only for link authorization and prevents two users claiming the same GitHub account within one workspace.
- [0008](migrations/0008_projects.sql) enforces project status `active|archived`, a lowercase alphanumeric/hyphen key of 1 to 40 characters with alphanumeric ends, unique workspace/key, and `archived_at` present exactly for archived projects.
- [0009](migrations/0009_agent_worklog.sql) extends comment targets with `project`, restricts source to `human|agent`, and permits NULL kind or `progress|decision|blocker|note`. Revoking an API token clears its comment attribution reference rather than deleting comments.
- [0012](migrations/0012_image_attachments.sql) requires exactly one issue/milestone target with same-workspace composite foreign keys, source `human|agent`, filename length 1 to 255, trimmed caption length 1 to 2000, PNG/JPEG/WebP content type, bytes 1 to 10485760 matching stored data length, positive dimensions and at most 20000000 pixels. Retry uniqueness includes target, uploader, digest and caption hash.
- [0013](migrations/0013_link_suggestions.sql) requires exactly one PR/comment subject, unique per subject, with nullable probability otherwise in `0..1`; a NULL issue records no confident match.
- [0014](migrations/0014_cli_scoped_keys.sql) requires API-token workspace/project scope together and restricts consent status to `pending|approved|denied|collected`, with unique device hash and user code. [0016](migrations/0016_cli_setup_tokens.sql) gives parent deletion cascading child revocation and one child per non-NULL parent/project pair.

## Side Effects
- Creates `schema_migration` and runs DDL. Tables include `app_user`, `workspace`, `membership`, `session`, `project`, `sprint`, `sprint_snapshot`, `milestone`, `issue`, `label`, `issue_label`, `comment`, `comment_mention`, `activity`, `github_installation`, `repo`, `pull_request`, `pr_link`, `pr_review`, `commit_ref`, `github_event`, `job`, `login_token`, `invite`, `github_setup_state`, `github_authorization_state`, `api_token`, `membership_github_identity`, `image_attachment`, `image_upload_grant` (dropped in `0015`), `link_suggestion`, `cli_session`.

## Verification
- Run: `cd api && go test ./internal/db/...`
