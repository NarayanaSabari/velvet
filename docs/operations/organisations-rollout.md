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

## Contract failure and rollback

The migration runner executes each migration and its `schema_migration` insert in one PostgreSQL transaction.
If `0006` fails before commit, PostgreSQL rolls back all of its changes, `0005` remains intact, and `0006_email_identity.sql` is absent from `schema_migration`.
Confirm that state from the database rather than inferring it from CI or container status.
Only when `0006` did not commit may the operator redeploy the recorded foundation image and end the maintenance window after health checks pass.

If `0006` is present in `schema_migration`, do not run the old API or worker against the contracted schema.
A successful contract migration cannot be rolled back by selecting the old application tag.
Rollback requires a new maintenance window, stopping application writers, restoring the designated contract rollback backup captured after the empty second preflight, and only then redeploying the recorded foundation image.
`pg_restore --clean --if-exists` drops and recreates database objects, so confirm the exact dump and target before approving that destructive restore.
