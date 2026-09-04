#!/usr/bin/env bash
# Destroys the throwaway stack, including volumes, so the next run starts from
# an empty database.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

: "${E2E_PROJECT:=worklog-e2e}"

cd "$root/deploy"
if [ -f "$here/.env.generated" ]; then
  docker compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" down -v >/dev/null 2>&1 || true
  rm -f "$here/.env.generated"
fi
echo "stack torn down"
