# deploy

Production-shaped Compose stack, Caddy edge, environment examples, backup tooling, and deployment verification scripts.

## Interface

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Services `postgres`, `migrate`, `api`, `worker`, `web`, `caddy`. Volumes `pgdata`, `caddydata`, `webdist`. Networks `default`, `proxy`. Images from `${IMAGE_REPO}/api` and `${IMAGE_REPO}/web` at `${IMAGE_TAG}`. |
| `Caddyfile` | `{$SITE_ADDRESS}` site. Proxies `/api/*` and `/webhooks/*` to `api:8080` with `X-Forwarded-For {remote_host}`. Serves `/download/*` from `/srv` with no SPA fallback. Other paths use `try_files {path} /index.html`. Sets `nosniff`, `X-Frame-Options DENY`, and `strict-origin-when-cross-origin`. |
| `.env.example` | Variable names for site, ports, proxy subnet and IPs, Postgres, Resend mail, GitHub App, and `TYPESAFE_API_KEY`/`TYPESAFE_MODEL`. Copy to ignored `.env.local`. |
| `preflight.sh [workspace-slug]` | Checks email onboarding and optional GitHub configuration. Slug defaults to `lab`. |
| `remote-deploy.sh <image-tag>` | Production host deploy of one tag. Registry token is read from stdin. |
| `backup.sh` | Nightly `pg_dump -Fc` to `BACKUP_DIR` (default `./backups`) with `RETENTION_DAYS` (default 14). |
| `verify-setup.sh` | Runs `e2e/tests/onboarding.spec.ts` against the disposable e2e stack. |
| `verify-localhost.sh` | Alias that execs `verify-setup.sh`. |
| `rollout.test.mjs` | `node --test` checks for deployment workflow and rollout ordering. |

## Invariants

- `preflight.sh` rejects slugs not matching `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` and reads the env file instead of sourcing it.
- `remote-deploy.sh` never builds. It pulls before `up`, so a failed pull leaves old containers running, and it reports success only once the API answers on the public URL.
- `remote-deploy.sh` exits 64 without a tag. An older tag requires a compatible schema (after migration 0006, restore the pre-contract backup first).
- `backup.sh` treats every step as fatal and requires `POSTGRES_USER`.
- `backup.sh` sources `ENV_FILE` (default `.env.local`) as shell code when the file exists, not merely as dotenv data. Use only a trusted, operator-controlled file: its contents execute with the backup process's privileges.
- Setting `BACKUP_S3_URL` requires the AWS CLI and configured credentials and destination access. The script uploads the database dump to that external S3 destination with `aws s3 cp`; approve the destination and its access controls before enabling it.
- `verify-setup.sh` sources `e2e/stack-common.sh`, so it only targets the guarded `worklog-e2e-organisations` project, never a configured deployment.

## Side effects

- `remote-deploy.sh` logs in to the registry, pulls images, restarts services, and runs migrations on the production host.
- After public API health succeeds, `remote-deploy.sh` runs `docker image prune -f --filter "until=168h"` and writes the deployed tag to `deploy/.deployed-tag`. Pruning targets dangling images older than 168 hours across the Docker host, not only this Compose project; prune errors are ignored.
- `backup.sh` writes `worklog-<UTC stamp>.dump` files, optionally uploads them to `BACKUP_S3_URL`, and prunes old local dumps only after the dump and any configured upload succeed.
- `verify-*.sh` leave the e2e stack running.

## Verification

```bash
node --test deploy/rollout.test.mjs e2e/stack-safety.test.mjs
./deploy/verify-setup.sh
```

Never commit `.env.local` or other filled environment files.
