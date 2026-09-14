# Organisations two-release rollout

This runbook separates the additive `0005_organisations.sql` migration from the feature's `0006_email_identity.sql` contract migration.
Merging to `main` is a production deployment approval because `.github/workflows/ci.yml` deploys every successful push to `main`.
Opening either pull request is only a review action and does not publish images or deploy.
Do not combine the two releases.

## Release 1: additive foundation

### 1. Confirm the release contents

The foundation branch must point to `409c5ca` and contain `0005`, its migration test, the design, and the plan on top of the current `origin/main`.
It must not contain `35b2358` or any later mail code.
That mail-validation commit currently applies production mail requirements to every command, including `worker` and `migrate`, and is not safe in the foundation image.

Run these checks from a clean repository after fetching the current remote:

```bash
git fetch origin
test "$(git rev-parse t3code/organisations-foundation)" = \
  "$(git rev-parse 409c5ca)"
git merge-base --is-ancestor origin/main t3code/organisations-foundation
! git merge-base --is-ancestor 35b2358 t3code/organisations-foundation
git diff origin/main...t3code/organisations-foundation --stat
git diff --check origin/main...t3code/organisations-foundation
```

`0005` is additive.
It adds nullable columns, new tables, foreign keys, and indexes, and relaxes the two GitHub identity `NOT NULL` constraints.
It does not delete data, drop a table or column, require an email backfill, or contain `0006`.

Review and approve the foundation pull request separately from approving its merge.
Do not merge until the backup below is complete and the operator is ready for the automatic production deployment.

### 2. Back up production before approving the merge

On the production host, run the repository's backup script and retain its output path:

```bash
cd /srv/worklog
./deploy/backup.sh
```

The script creates a non-empty custom-format `pg_dump`, optionally uploads it to `BACKUP_S3_URL`, and only then prunes expired local backups.
Confirm the reported dump exists and run `pg_restore --list` against it before continuing.
Record the dump path, size, creation time, and remote object location when configured.

### 3. Approve and observe the foundation deployment

Merge the foundation pull request only after explicit deployment approval.
The push to `main` runs the Go, web, and end-to-end suites, builds commit-tagged API and web images, and invokes `deploy/remote-deploy.sh` on the host.
The deploy script pulls `migrate`, `api`, and `worker` from the API image plus the separate `web` image before changing containers, then Compose runs the one-shot `migrate` service before starting the API and worker.
The deploy is successful only after the public health endpoint responds.

Record the deployed main commit and the exact image tag written to `/srv/worklog/deploy/.deployed-tag`.
Keep this foundation tag for the contract-release recovery path.

Verify that `0005` is recorded:

```bash
cd /srv/worklog/deploy
docker compose --env-file .env.local -p worklog exec -T postgres \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT name, applied_at
FROM schema_migration
WHERE name = '0005_organisations.sql';
SQL
```

Do not continue unless this returns exactly one row and the deployed API is healthy.

### 4. Run the first read-only preflight

Run all four queries and save their complete output with the release record:

```sql
SELECT id, github_login FROM app_user WHERE email IS NULL OR btrim(email) = '';
SELECT id, workspace_id, invited_login FROM membership WHERE user_id IS NULL;
SELECT installation_id FROM repo
GROUP BY installation_id HAVING count(DISTINCT workspace_id) > 1;
SELECT workspace_id FROM repo
GROUP BY workspace_id HAVING count(DISTINCT installation_id) > 1;
```

Run them read-only with:

```bash
cd /srv/worklog/deploy
docker compose --env-file .env.local -p worklog exec -T postgres \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN READ ONLY;
SELECT id, github_login FROM app_user WHERE email IS NULL OR btrim(email) = '';
SELECT id, workspace_id, invited_login FROM membership WHERE user_id IS NULL;
SELECT installation_id FROM repo
GROUP BY installation_id HAVING count(DISTINCT workspace_id) > 1;
SELECT workspace_id FROM repo
GROUP BY workspace_id HAVING count(DISTINCT installation_id) > 1;
COMMIT;
SQL
```

The first query supplies the exact user UUIDs that need operator-provided email addresses.
Do not derive an address from `github_login`.
The second query identifies memberships that must be bound to a known user UUID or removed as obsolete using an explicitly approved membership-ID list.
Either installation query returning a row blocks the feature release until an operator explicitly resolves ownership.
Do not choose an organisation automatically.

### 5. Apply the approved data mapping

Prepare a two-column mapping of `user_id,email`, review it out of band with the operator, and replace every example value below before running anything.
Email values must be trimmed, lowercase, non-empty, and unique.
Use user UUIDs as the update key so GitHub-login changes cannot redirect a backfill.

```sql
BEGIN;

CREATE TEMP TABLE operator_email_mapping (
    user_id uuid PRIMARY KEY,
    email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> '')
) ON COMMIT DROP;

-- Replace this complete VALUES list with the approved user UUID to email map.
INSERT INTO operator_email_mapping (user_id, email) VALUES
    ('00000000-0000-0000-0000-000000000000', 'operator-supplied@example.com');

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM operator_email_mapping m
        LEFT JOIN app_user u ON u.id = m.user_id
        WHERE u.id IS NULL OR (u.email IS NOT NULL AND btrim(u.email) <> '')
    ) THEN
        RAISE EXCEPTION 'mapping contains an unknown or already populated user UUID';
    END IF;
    IF (SELECT count(*) FROM operator_email_mapping) <>
       (SELECT count(*) FROM app_user WHERE email IS NULL OR btrim(email) = '') THEN
        RAISE EXCEPTION 'mapping does not cover every email-less user';
    END IF;
    IF EXISTS (
        SELECT lower(email) FROM operator_email_mapping
        GROUP BY lower(email) HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1
        FROM operator_email_mapping m
        JOIN app_user u ON lower(u.email) = lower(m.email)
    ) THEN
        RAISE EXCEPTION 'mapping conflicts with an existing or mapped email';
    END IF;
END $$;

UPDATE app_user u
SET email = m.email, updated_at = now()
FROM operator_email_mapping m
WHERE u.id = m.user_id;

SELECT u.id, u.github_login, u.email
FROM app_user u
JOIN operator_email_mapping m ON m.user_id = u.id
ORDER BY u.id;

COMMIT;
```

Run the reviewed transaction through `psql -X -v ON_ERROR_STOP=1` and retain its output.
Resolve unclaimed memberships only from a separately reviewed list of exact membership UUIDs and intended user UUIDs or exact obsolete membership UUIDs.
Take another backup after all approved corrections are complete.
This is an intermediate safety copy, not the contract rollback backup, because legacy writers remain active until the later maintenance gate.

## Between releases

Keep the foundation release running until the complete feature pull request has passed review and tests and the second deployment is approved.
The legacy GitHub OAuth route remains live during this interval.
Every successful sign-in for a previously unseen GitHub account can insert another `app_user` with no email, and invitations can leave another membership with no `user_id`.
Therefore, a clean first preflight is not sufficient evidence for `0006`.

Before the feature release, verify that mail validation is serve-only, workers and migrations can start without mail settings, and the API service receives its required mail settings.
Do not use the foundation image if it contains the earlier unconditional mail-validation commit.

## Release 2: feature and contract

### Mail and deployment configuration

Before scheduling the maintenance window, verify the Resend sending domain `mail.velvet.sabarinarayana.com` and prepare `RESEND_API_KEY` and `MAIL_FROM` in the operator-managed host environment.
The API refuses HTTPS startup without both; worker and migration commands do not require mail configuration.
Use the verified domain in the sender, for example `Velvet <noreply@mail.velvet.sabarinarayana.com>`.
Never substitute that example for an operator-approved address or backfill mapping.
Production delivery must be checked through an approved recipient's real confirmation flow after deployment; local log-mail tests do not validate Resend delivery or DNS.

Compose forwards `GITHUB_APP_SLUG` to the API along with App user-authorization credentials, App ID, private key, and webhook secret.
Set the slug even when legacy OAuth credentials remain in the host environment; those old credentials are not the App credentials and cannot enable email sign-in.
For several local stacks, choose unique host ports and a non-overlapping `PROXY_SUBNET`, then set both `PROXY_CADDY_IP` and `PROXY_API_IP` inside it.
Compose trusts only the fixed Caddy address (`/32`) for forwarded client IPs.
Changing the subnet alone leaves the fixed addresses inconsistent.

### GitHub App authorization settings

Make the App public so other accounts and organisations can install it.
Configure the GitHub App's callback URL as `BASE_URL/api/v1/auth/github/callback` and its setup URL as `BASE_URL/api/v1/github/setup`.
Disable **Request user authorization (OAuth) during installation** and **Redirect on update**.
Velvet starts user authorization explicitly after claiming the setup state, so automatic authorization must not bypass that state and PKCE flow.
Make these App settings changes only as part of the separately approved operator rollout.

Set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` from the GitHub App's user authorization credentials.
These are separate from the App id and private key used by installation workers, and from any legacy OAuth App credentials.
User access and refresh tokens are never retained after authorization.
Local verification may override `GITHUB_INSTALLATION_URL`, `GITHUB_AUTHORIZATION_URL`, `GITHUB_TOKEN_URL`, and `GITHUB_API_URL` with a disposable HTTP stub.
The installation URL defaults to `https://github.com/apps/{GITHUB_APP_SLUG}/installations/new`.
Production defaults for the other URLs are GitHub's public authorization, token, and REST endpoints.
These endpoint overrides are for a disposable provider or GitHub Enterprise, not required ordinary GitHub.com configuration.
The browser must be able to reach the installation and authorization URLs, while the API and worker processes must be able to reach the token and REST URLs.
Check repository permissions for Contents, Metadata, and Pull requests reads; subscribe to Pull request, Pull request review, and Push events, and configure `BASE_URL/webhooks/github` with the matching webhook secret.
Check the actual organisation owner can authorize the App and that the authenticated-user membership listing returns its active `admin` membership before considering ownership verification operational.
The [authenticated-user membership endpoint](https://docs.github.com/en/rest/orgs/members#list-organization-memberships-for-the-authenticated-user) supports App user tokens; the verified flow reads all pages and fails closed if ownership cannot be established.

The installation authorization completer atomically binds the installation, enqueues synchronization, and completes both callback states.
Administration offers Connect GitHub for new connections and Verify GitHub ownership for migrated bindings.
Migrated bindings cannot discover repositories through retry, installation events, or scheduled reconciliation until that verification succeeds.
Verified bindings can retry a failed synchronization from Administration without repeating authorization.
Repository ownership conflicts leave the entire repository list unchanged and display a sanitized error.

### 1. Prepare the maintenance gate

Obtain separate approval for the feature merge and production deployment.
Confirm the feature image includes `0006_email_identity.sql`, its populated-`0005` upgrade tests, and application code compatible with the contracted schema.
Record the foundation image tag and the latest post-backfill backup path.

The current `deploy/remote-deploy.sh` does not stop the old API and worker before running migrations.
The operator must establish the maintenance window and stop both legacy writers before approving the merge to `main`:

```bash
cd /srv/worklog/deploy
docker compose --env-file .env.local -p worklog stop api worker
```

Do not restart either old service while the contract release is pending.

### 2. Run the second preflight immediately before `0006`

With the old API and worker stopped, run the same four read-only queries again:

```sql
SELECT id, github_login FROM app_user WHERE email IS NULL OR btrim(email) = '';
SELECT id, workspace_id, invited_login FROM membership WHERE user_id IS NULL;
SELECT installation_id FROM repo
GROUP BY installation_id HAVING count(DISTINCT workspace_id) > 1;
SELECT workspace_id FROM repo
GROUP BY workspace_id HAVING count(DISTINCT installation_id) > 1;
```

All four result sets must be empty.
Because both legacy writers are stopped, that result remains stable until the migration runs.
If any query returns a row, do not apply `0006`, do not merge, and either resolve it under a newly approved data-change list or restart the foundation release and reschedule the maintenance window.

### 3. Create and verify the contract rollback backup

After both legacy writers are stopped and all four second-preflight result sets are empty, create a fresh backup immediately before the contract merge:

```bash
cd /srv/worklog
./deploy/backup.sh
```

Confirm the newly reported dump is non-empty and that `pg_restore --list` can read it.
Record its exact path, size, creation time, and remote object location when configured, and designate this exact dump as the contract rollback backup.
Do not restart the old API or worker or perform any other production write between this backup and the contract migration.
If the merge or deployment is delayed, repeat the second preflight and create and verify a new contract rollback backup.

### 4. Approve the contract deployment

Only after the second preflight is empty, approve and merge the feature pull request.
The push to `main` runs CI, builds the images, and invokes `remote-deploy.sh`.
Compose runs `0006` in the migration service before it starts the new API and worker.

Verify public health and then verify the migration record:

```sql
SELECT name, applied_at
FROM schema_migration
WHERE name IN ('0005_organisations.sql', '0006_email_identity.sql')
ORDER BY name;
```

Do not end the maintenance window until both rows exist and the new application passes its production smoke checks.

### 5. Production smoke checks and release record

Use operator-approved accounts and organisations for these actions; do not modify an existing organisation merely to test destructive flows.
Record the final feature commit, both image tags, migration output, second-preflight output, designated rollback dump, operator approvals, and smoke-check results together.

- Request a sign-in link to an approved address, confirm mail delivery, open the link without creating a session, then click Sign in and verify the expected existing identity and organisation.
- Confirm the last organisation selection, existing email-only member names, and retained issue/PR evidence.
- Where approved, create an organisation and invite a test colleague; verify matching-address acceptance and membership.
- Verify each migrated GitHub installation through its owner in Administration before expecting discovery of additional repositories.
  Confirm successful synchronization and preserved existing repository ownership.
- Confirm signed webhook delivery and a PR appearing on its intended issue without changing issue status.
- Confirm profile linking separately when needed; installation verification must not implicitly link the admin's profile.

`deploy/preflight.sh` is a supplementary operator diagnostic, not a migration preflight or a delivery/authorization proof.
It reads the selected environment file and sends signed and invalid diagnostic ping webhooks; run it only against the intended deployment after configuration is approved.
The replacement local setup entrypoints share the guarded browser suite and never target a production deployment.
The removed bootstrap, login-invite, and manual repository-connection scripts are superseded by signup and Administration.

## GitHub lifecycle recovery

Repository removal marks historical rows disconnected and retains PRs, reviews, commits, links, and issue evidence.
Only a complete successful repository listing may disconnect absent repositories, and reconnecting reuses the retained row without moving it between organisations.
Suspension pauses access and reconciliation.
After a provider state-check failure, Administration reports suspended plus `sync_failed`; resolve the provider problem and click **Retry sync** to recheck the installation before resuming discovery.

A current-state API 404 is not terminal deletion authority.
It fails closed, retains the installation binding and evidence, and requires provider access recovery or the authentic signed lifecycle delivery.
Only a verified `installation.deleted` webhook marks that installation ID permanently deleted and unbinds it.
If a deletion delivery was missed, an operator can inspect and redeliver that authentic GitHub event as an approved operational action.
Never synthesize deletion from an HTTP status or directly reassign ownership to bypass a stale binding.
Without webhooks, active repositories can reconcile PRs hourly, but terminal-deletion recovery is unavailable until a signed deletion delivery is recovered.
After deletion, Connect GitHub can verify a new installation; stale events from the deleted ID cannot overwrite retained evidence.

## Contract failure and rollback

The migration runner executes each migration and its `schema_migration` insert in one PostgreSQL transaction.
If `0006` fails before commit, PostgreSQL rolls back all of its changes, `0005` remains intact, and `0006_email_identity.sql` is absent from `schema_migration`.
Confirm that state from the database rather than inferring it from CI or container status.
Only when `0006` did not commit may the operator redeploy the recorded foundation image and end the maintenance window after health checks pass.

If `0006` is present in `schema_migration`, do not run the old API or worker against the contracted schema.
A successful contract migration cannot be rolled back by selecting the old application tag.
Rollback requires a new maintenance window, stopping application writers, restoring the designated contract rollback backup captured after the empty second preflight, and only then redeploying the recorded foundation image.
`pg_restore --clean --if-exists` drops and recreates database objects, so confirm the exact dump and target before approving that destructive restore.
