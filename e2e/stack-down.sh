#!/usr/bin/env bash
# Destroys the throwaway stack, including volumes, so the next run starts from
# an empty database.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/stack-common.sh"
if [ -f "$here/.env.generated" ]; then
  docker_local ps -a --filter "label=com.docker.compose.project=$E2E_PROJECT" --format '{{.Names}}'
  docker_local volume ls --filter "label=com.docker.compose.project=$E2E_PROJECT" --format '{{.Name}}'
  compose down -v
fi
echo "test stack torn down"
