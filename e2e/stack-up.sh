#!/usr/bin/env bash
# Brings up the full production stack on a throwaway port and waits for it to
# be healthy. Testing the real Compose stack rather than a dev server is the
# point: the deployment bugs this project actually hit - a crash-looping
# worker, a Caddy port mismatch - were invisible to `vite dev`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

export E2E_PORT="${E2E_PORT:-8099}"
export E2E_PROJECT="${E2E_PROJECT:-worklog-e2e}"

env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT

# Test-only values. Nothing here is a credential: the stack is destroyed at the
# end of the run and never reachable off this machine.
cat > "$env_file" <<EOF
SITE_ADDRESS=http://localhost:${E2E_PORT}
BASE_URL=http://localhost:${E2E_PORT}
HTTP_PORT=${E2E_PORT}
HTTPS_PORT=$((E2E_PORT + 1))
CADDY_HTTP_PORT=${E2E_PORT}
CADDY_HTTPS_PORT=$((E2E_PORT + 1))
POSTGRES_USER=worklog
POSTGRES_PASSWORD=e2e-local-only
POSTGRES_DB=worklog
DATABASE_URL=postgres://worklog:e2e-local-only@postgres:5432/worklog?sslmode=disable
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=e2e-webhook-secret
BACKUP_S3_URL=
EOF

cp "$env_file" "$here/.env.generated"

cd "$root/deploy"
docker compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" down -v >/dev/null 2>&1 || true
docker compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" up -d --build

# Poll rather than sleep: a fixed sleep is either slow or flaky, and this loop
# fails loudly with logs instead of leaving Playwright to time out mysteriously.
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${E2E_PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "stack healthy on port ${E2E_PORT}"
    exit 0
  fi
  sleep 2
done

echo "stack failed to become healthy; recent logs:" >&2
docker compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" ps >&2
docker compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" logs --tail 40 >&2
exit 1
