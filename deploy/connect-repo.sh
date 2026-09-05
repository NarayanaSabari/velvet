#!/usr/bin/env bash
#
# Connects a GitHub repository to a workspace.
#
# The admin UI accepts these values directly. This script remains the quickest
# path when the values GitHub gives you are scattered across different pages:
# give it an owner/name and it resolves both numeric ids before posting them.
#
# Usage:
#   GITHUB_TOKEN=ghp_... ./connect-repo.sh <owner/repo> [workspace-slug]
#
# The token only needs to read the repository and list your app installations;
# it is used for this one lookup and never stored.
set -euo pipefail

repo_full="${1:-}"
slug="${2:-lab}"
base="${BASE_URL:-http://localhost:8088}"
# Overridable so the script works against GitHub Enterprise, and so its parsing
# can be tested against a stub instead of the real API.
gh_api="${GITHUB_API_URL:-https://api.github.com}"

if [ -z "$repo_full" ]; then
  echo "usage: GITHUB_TOKEN=... $0 <owner/repo> [workspace-slug]" >&2
  exit 64
fi

if [ -z "${SESSION_TOKEN:-}" ]; then
  echo "error: set SESSION_TOKEN to an admin session cookie value." >&2
  echo "       Sign in, then copy the ticket_session cookie from your browser." >&2
  exit 64
fi

owner="${repo_full%%/*}"
name="${repo_full##*/}"

api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" "$@"
  else
    curl -fsS -H "Accept: application/vnd.github+json" "$@"
  fi
}

echo "Looking up ${owner}/${name}…"
if ! repo_json=$(api "${gh_api}/repos/${owner}/${name}"); then
  echo "error: could not read ${owner}/${name}. Check the name and that GITHUB_TOKEN can see it." >&2
  exit 1
fi
read -r repo_id default_branch <<<"$(printf '%s' "$repo_json" |
  python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["id"], d["default_branch"])')"

# The installation id is what lets the worker mint a token for this repo. It is
# also visible in the URL when you open the App's install settings page.
installation_id="${INSTALLATION_ID:-}"
if [ -z "$installation_id" ]; then
  echo "Looking up the App installation for ${owner}…"
  installation_id=$(api "${gh_api}/repos/${owner}/${name}/installation" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null || true)
fi

if [ -z "$installation_id" ]; then
  cat >&2 <<EOF
error: could not find an App installation for ${owner}/${name}.

  Install the GitHub App on that repository first, then either re-run this
  script or pass the id directly:

    INSTALLATION_ID=12345678 $0 ${repo_full} ${slug}

  The id is the last number in the URL when you open
  Settings, Integrations, and click Configure on the App.
EOF
  exit 1
fi

echo "repository id  ${repo_id}"
echo "installation   ${installation_id}"
echo "default branch ${default_branch}"

response=$(curl -fsS -X POST "${base}/api/v1/w/${slug}/repos" \
  -H "Cookie: ticket_session=${SESSION_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"github_id\":${repo_id},\"owner\":\"${owner}\",\"name\":\"${name}\",\"installation_id\":${installation_id},\"default_branch\":\"${default_branch}\"}")

echo "$response" | python3 -c '
import sys, json
r = json.load(sys.stdin)
print("connected", r["owner"] + "/" + r["name"])
'

cat <<EOF

Done. The worker backfills the last 90 days of pull requests on its next
reconcile pass, which runs at startup and hourly after that.

Name a branch after an issue key to see it link itself:

    git switch -c yourname/eng-1-some-change
EOF
