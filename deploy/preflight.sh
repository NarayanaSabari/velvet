#!/usr/bin/env bash
#
# Checks that the GitHub configuration is actually wired up.
#
# Every failure mode here is silent in normal use: a wrong webhook secret
# rejects deliveries that GitHub reports as sent, an unquoted private key
# truncates at the first newline, and a repository that was never connected
# drops its events as unattributable. Each one looks like "the integration
# just does not work" days later, so check them explicitly.
#
# Usage:
#   ./preflight.sh [workspace-slug]
set -euo pipefail

slug="${1:-lab}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${ENV_FILE:-$here/.env.local}"
project="${COMPOSE_PROJECT:-worklog}"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found. Copy .env.example and fill it in first." >&2
  exit 1
fi

# Read the file rather than sourcing it. A malformed value - the classic being
# an unquoted multi-line PEM - makes `.` fail outright, which would abort the
# very check meant to diagnose that mistake.
env_get() {
  python3 - "$env_file" "$1" <<'PYEOF'
import sys

path, key = sys.argv[1], sys.argv[2]
raw = open(path).read()

value = ""
for start in range(len(raw)):
    if not raw.startswith(key + "=", start):
        continue
    if start and raw[start - 1] != "\n":
        continue
    rest = raw[start + len(key) + 1:]
    # A quoted value runs to its closing quote, newlines and all. That is how
    # a PEM is written, and reading only the first line would report a
    # correctly quoted key as truncated.
    if rest[:1] in ('"', "'"):
        quote = rest[0]
        end = rest.find(quote, 1)
        value = rest[1:end] if end != -1 else rest[1:]
    else:
        value = rest.split("\n", 1)[0].strip()
    break

print(value)
PYEOF
}

BASE_URL="$(env_get BASE_URL)"
POSTGRES_USER="$(env_get POSTGRES_USER)"
POSTGRES_DB="$(env_get POSTGRES_DB)"
GITHUB_CLIENT_ID="$(env_get GITHUB_CLIENT_ID)"
GITHUB_CLIENT_SECRET="$(env_get GITHUB_CLIENT_SECRET)"
GITHUB_WEBHOOK_SECRET="$(env_get GITHUB_WEBHOOK_SECRET)"
GITHUB_APP_ID="$(env_get GITHUB_APP_ID)"
GITHUB_APP_PRIVATE_KEY="$(env_get GITHUB_APP_PRIVATE_KEY)"

base="${BASE_URL:-http://localhost:8088}"

pass=0
fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; fail=$((fail + 1)); }
warn() { printf '  note  %s\n' "$1"; }

psql_q() {
  docker compose --env-file "$env_file" -p "$project" exec -T postgres \
    psql -U "${POSTGRES_USER:-worklog}" -d "${POSTGRES_DB:-worklog}" -tA -c "$1" 2>/dev/null || true
}

echo "Checking ${base}"
echo

# --- The app is up -----------------------------------------------------------
if curl -fsS "${base}/api/v1/health" >/dev/null 2>&1; then
  ok "API is reachable"
else
  bad "API is not reachable at ${base}/api/v1/health" \
      "Start the stack: docker compose --env-file $env_file -p $project up -d"
  echo
  echo "Stopping here: nothing else can be checked while the API is down."
  exit 1
fi

# --- OAuth -------------------------------------------------------------------
if [ -n "${GITHUB_CLIENT_ID:-}" ] && [ -n "${GITHUB_CLIENT_SECRET:-}" ]; then
  ok "OAuth app configured"
  # A redirect to github.com means the app built the authorize URL; anything
  # else means the client id never reached the process.
  location=$(curl -s -o /dev/null -w '%{redirect_url}' "${base}/api/v1/auth/github/login" || true)
  case "$location" in
    https://github.com/login/oauth/authorize*) ok "sign-in redirects to GitHub" ;;
    "") bad "sign-in did not redirect" "Check GITHUB_CLIENT_ID reached the api container." ;;
    *)  bad "sign-in redirected somewhere unexpected" "Got: $location" ;;
  esac
else
  bad "OAuth app not configured" \
      "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; without them nobody can sign in."
fi

# --- Webhook secret ----------------------------------------------------------
if [ -n "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  body='{"zen":"preflight"}'
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | awk '{print $NF}')

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/webhooks/github" \
    -H 'X-GitHub-Event: ping' -H "X-GitHub-Delivery: preflight-$(date +%s)" \
    -H "X-Hub-Signature-256: sha256=${sig}" \
    -H 'Content-Type: application/json' -d "$body" || true)

  if [ "$code" = "200" ]; then
    ok "webhook secret matches (a correctly signed delivery is accepted)"
  else
    bad "a correctly signed webhook was rejected (HTTP ${code})" \
        "GITHUB_WEBHOOK_SECRET here differs from the one set on the App."
  fi

  # The negative half matters as much: an endpoint that accepts anything is
  # worse than one that rejects everything.
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/webhooks/github" \
    -H 'X-GitHub-Event: ping' -H "X-GitHub-Delivery: preflight-bad-$(date +%s)" \
    -H 'X-Hub-Signature-256: sha256=deadbeef' \
    -H 'Content-Type: application/json' -d "$body" || true)
  if [ "$code" = "401" ]; then
    ok "unsigned deliveries are refused"
  else
    bad "an unsigned webhook was not refused (HTTP ${code})" \
        "This endpoint is public; it must reject anything it cannot verify."
  fi
else
  # Not a failure: without a public URL there is nothing for GitHub to call,
  # and reconciliation still links pull requests on its hourly pass. Webhooks
  # buy latency, not capability.
  warn "no webhook secret set; pull requests will link on the hourly poll instead of instantly"
fi

# --- App private key ---------------------------------------------------------
if [ -z "${GITHUB_APP_ID:-}" ] || [ -z "${GITHUB_APP_PRIVATE_KEY:-}" ]; then
  warn "GitHub App not configured; the worker runs but never syncs pull requests"
else
  ok "App id and private key are set"
  case "$GITHUB_APP_PRIVATE_KEY" in
    *"BEGIN"*"PRIVATE KEY"*"END"*"PRIVATE KEY"*)
      ok "private key looks like a complete PEM" ;;
    *)
      bad "private key is not a complete PEM" \
          "Quote it in ${env_file}, keeping the BEGIN and END lines: an unquoted value truncates at the first newline." ;;
  esac
fi

# --- Connected repositories --------------------------------------------------
repos=$(psql_q "SELECT count(*) FROM repo")
if [ "${repos:-0}" -gt 0 ]; then
  ok "${repos} repository/repositories connected"
  psql_q "SELECT '        ' || owner || '/' || name || '  installation=' || installation_id FROM repo ORDER BY owner, name"
else
  bad "no repositories connected" \
      "Run ./connect-repo.sh <owner/repo> ${slug}; until then deliveries are dropped as unattributable."
fi

# --- Members -----------------------------------------------------------------
members=$(psql_q "SELECT count(*) FROM membership m JOIN workspace w ON w.id = m.workspace_id WHERE w.slug = '${slug}'")
if [ "${members:-0}" -gt 0 ]; then
  ok "${members} member(s) invited to '${slug}'"
else
  bad "no members invited to '${slug}'" \
      "Run ./bootstrap.sh <your-github-login> to create the workspace and first admin."
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All ${pass} checks passed."
else
  echo "${pass} passed, ${fail} failed."
  exit 1
fi
