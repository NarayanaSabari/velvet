#!/usr/bin/env bash
# Brings up the full production stack on a throwaway port and waits for it to
# be healthy. Testing the real Compose stack rather than a dev server is the
# point: the deployment bugs this project actually hit - a crash-looping
# worker, a Caddy port mismatch - were invisible to `vite dev`.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/stack-common.sh"
node "$here/stack-env.mjs"
compose up -d --build

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
compose ps >&2
compose logs --tail 40 >&2
exit 1
