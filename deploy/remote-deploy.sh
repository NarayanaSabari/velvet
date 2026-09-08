#!/usr/bin/env bash
#
# Deploys one image tag on the production host. CI runs this over SSH after it
# has pushed the images. An older tag requires a compatible schema;
# after 0006, restore the pre-contract backup first as described in the runbook.
#
# Usage:
#   ./remote-deploy.sh <image-tag>            # registry token on stdin, or none
#
# The host never builds: it pulls the tag, restarts what changed, and refuses
# to report success until the API answers over the public URL. A pull that
# fails leaves the previous containers running untouched, which is the whole
# reason to pull before `up` rather than letting `up` do both.
#
# The registry token arrives on stdin so it is never on a command line or in a
# file. An empty stdin skips the login, which is what a public registry or a
# host that is already logged in wants.
set -euo pipefail

tag="${1:-}"
if [ -z "$tag" ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 64
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${ENV_FILE:-$here/.env.local}"
project="${COMPOSE_PROJECT:-worklog}"
registry="${IMAGE_REGISTRY:-ghcr.io}"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found." >&2
  exit 1
fi

# BASE_URL is the public origin; the health check has to go through Caddy and
# TLS, because "the container is up" and "users can reach it" are different
# claims and only the second one matters.
base_url=$(grep -E '^BASE_URL=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "$base_url" ]; then
  echo "error: BASE_URL is not set in $env_file" >&2
  exit 1
fi

cd "$here"
compose() { docker compose --env-file "$env_file" -p "$project" "$@"; }

if [ ! -t 0 ]; then
  token=$(cat || true)
  if [ -n "$token" ]; then
    printf '%s' "$token" | docker login "$registry" -u token --password-stdin >/dev/null
    trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT
  fi
fi

echo "pulling $tag"
IMAGE_TAG="$tag" compose pull --quiet migrate api worker web

echo "starting $tag"
IMAGE_TAG="$tag" compose up -d --no-build --remove-orphans

for i in $(seq 1 30); do
  if curl -fsS -m 10 "$base_url/api/v1/health" >/dev/null 2>&1; then
    echo "healthy: $base_url"
    # Keep the previous tag around for a manual rollback; drop anything older.
    docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
    echo "$tag" > "$here/.deployed-tag"
    exit 0
  fi
  sleep 5
done

echo "error: $base_url did not become healthy within 150s; recent state:" >&2
compose ps >&2
compose logs --tail 30 migrate api >&2
exit 1
