#!/usr/bin/env bash
#
# Invites a GitHub login to a workspace.
#
# Sign-in is invite-gated: an uninvited account gets no session at all, so this
# is how someone gains access. The invite is claimed the first time they sign
# in, which means they do not need a user record beforehand.
#
# Usage:
#   ./invite.sh <github-login> [role] [workspace-slug]
#
# Roles: admin (membership, repos, sprint lifecycle), member (default), viewer.
set -euo pipefail

login="${1:-}"
role="${2:-member}"
slug="${3:-lab}"

if [ -z "$login" ]; then
  echo "usage: $0 <github-login> [admin|member|viewer] [workspace-slug]" >&2
  exit 64
fi

case "$role" in
  admin|member|viewer) ;;
  *) echo "error: role must be admin, member, or viewer (got '$role')" >&2; exit 64 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${ENV_FILE:-$here/.env.local}"
project="${COMPOSE_PROJECT:-worklog}"

cd "$here"
docker compose --env-file "$env_file" -p "$project" exec -T postgres \
  psql -U "${POSTGRES_USER:-worklog}" -d "${POSTGRES_DB:-worklog}" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO membership (workspace_id, invited_login, role)
SELECT w.id, lower('${login}'), '${role}'::membership_role
FROM workspace w WHERE w.slug = '${slug}'
ON CONFLICT (workspace_id, lower(invited_login))
DO UPDATE SET role = EXCLUDED.role;

-- If they have signed in before, bind the invite to the existing account so
-- access is immediate rather than waiting for another sign-in.
UPDATE membership m SET user_id = u.id
FROM app_user u
WHERE lower(u.github_login) = lower('${login}')
  AND lower(m.invited_login) = lower('${login}')
  AND m.user_id IS NULL;
SQL

echo "${login} invited to '${slug}' as ${role}."
