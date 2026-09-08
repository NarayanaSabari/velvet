#!/usr/bin/env bash
# Only this explicit disposable project may be started or destroyed here.
export E2E_PROJECT="${E2E_PROJECT:-worklog-e2e-organisations}"
if [ "$E2E_PROJECT" != worklog-e2e-organisations ]; then
  echo "Refusing non-test project: $E2E_PROJECT" >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
export E2E_PORT="${E2E_PORT:-18399}"
export E2E_PROVIDER_PORT="${E2E_PROVIDER_PORT:-18599}"
docker_local() {
  # Compose shell interpolation overrides --env-file. Clear every inherited
  # setting, including COMPOSE_* and DOCKER_*, and pin the local Unix daemon.
  env -i HOME="$HOME" PATH="$PATH" docker --host unix:///var/run/docker.sock "$@"
}
compose() {
  docker_local compose --env-file "$here/.env.generated" -p "$E2E_PROJECT" \
    -f "$root/deploy/docker-compose.yml" -f "$here/compose.yml" "$@"
}

# Playwright and shell scripts use exactly the same Docker/Compose boundary.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  compose "$@"
fi
