#!/usr/bin/env bash
#
# Creates the first workspace and invites its first admin.
#
# This is a chicken-and-egg step: sign-in is invite-gated, so the very first
# member cannot be invited through the app by anyone. Everyone after them can
# be invited with ./invite.sh.
#
# Usage:
#   ./bootstrap.sh <github-login> [workspace-name] [workspace-slug] [issue-prefix]
#
# Example:
#   ./bootstrap.sh sabari "Narayana" narayana ENG
set -euo pipefail

login="${1:-}"
name="${2:-Workspace}"
slug="${3:-lab}"
prefix="${4:-ENG}"

if [ -z "$login" ]; then
  echo "usage: $0 <github-login> [workspace-name] [workspace-slug] [issue-prefix]" >&2
  exit 64
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${ENV_FILE:-$here/.env.local}"
project="${COMPOSE_PROJECT:-worklog}"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found. Copy .env.example and fill it in first." >&2
  exit 1
fi

cd "$here"
docker compose --env-file "$env_file" -p "$project" exec -T postgres \
  psql -U "${POSTGRES_USER:-worklog}" -d "${POSTGRES_DB:-worklog}" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO workspace (name, slug, issue_prefix)
VALUES ('${name}', '${slug}', '${prefix}')
ON CONFLICT (slug) DO NOTHING;

-- The invite is claimed the first time this login signs in through OAuth, so
-- no user row has to exist yet.
INSERT INTO membership (workspace_id, invited_login, role)
SELECT w.id, '${login}', 'admin'
FROM workspace w WHERE w.slug = '${slug}'
ON CONFLICT (workspace_id, invited_login) DO UPDATE SET role = 'admin';
SQL

base="${BASE_URL:-$(grep -E '^BASE_URL=' "$env_file" | cut -d= -f2- || true)}"
cat <<EOF

Workspace '${name}' created, and ${login} invited as an admin.

Sign in at ${base:-your BASE_URL} and the invite is claimed automatically.
Invite the rest of the team with:

    ./invite.sh <github-login> [admin|member|viewer]
EOF
