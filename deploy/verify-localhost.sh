#!/usr/bin/env bash
#
# Walks a localhost install: no webhook secret, no webhook URL, nothing public.
#
# This is the configuration recommended for a local trial, so it needs the same
# end-to-end proof as the webhook path. The claim under test is that a pull
# request still reaches its issue, through reconciliation alone, with no
# delivery ever made.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

port="${LOCAL_PORT:-8096}"
stub_port="${LOCAL_STUB_PORT:-8796}"
project="localcheck"
env_file=".env.localcheck"
workdir="$(mktemp -d)"

cleanup() {
  docker compose --env-file "$env_file" -p "$project" down -v >/dev/null 2>&1 || true
  rm -f "$env_file"
  [ -n "${stub_pid:-}" ] && kill "$stub_pid" 2>/dev/null || true
  rm -rf "$workdir"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok   %s\n' "$1"; }
die()  { printf '   FAIL %s\n' "$1" >&2; exit 1; }

# A stub GitHub that already has the pull request, the way the real API would
# when a webhook was never delivered.
cat > "$workdir/stub.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, sys, time

REPO = {"id": 700124, "name": "platform", "full_name": "narayana/platform",
        "default_branch": "main", "owner": {"login": "narayana"}}
INSTALL = {"id": 55001133, "app_id": 424242, "account": {"login": "narayana"}}
TOKEN = {"token": "stub-installation-token",
         "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))}
PULLS = [{"number": 11, "title": "Wire up sign-in", "state": "open", "draft": False,
          "body": "", "additions": 40, "deletions": 5,
          "html_url": "https://github.com/narayana/platform/pull/11",
          "created_at": "2026-09-04T09:00:00Z", "updated_at": "2026-09-04T09:00:00Z",
          "merged_at": None, "user": {"login": "sabari"},
          "head": {"ref": "sabari/eng-1-wire-up-sign-in"}}]

class H(BaseHTTPRequestHandler):
    def _send(self, body, code=200):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/repos/narayana/platform/installation":
            self._send(INSTALL)
        elif self.path == "/repos/narayana/platform":
            self._send(REPO)
        elif self.path.startswith("/repos/narayana/platform/pulls"):
            self._send(PULLS)
        else:
            self._send({"message": "Not Found"}, 404)

    def do_POST(self):
        if self.path.endswith("/access_tokens"):
            self._send(TOKEN, 201)
        else:
            self._send({"message": "Not Found"}, 404)

    def log_message(self, *a):
        pass

HTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
PY

python3 "$workdir/stub.py" "$stub_port" &
stub_pid=$!
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${stub_port}/repos/narayana/platform" >/dev/null 2>&1 && break
  sleep 0.5
done

step "A localhost install: no webhook secret, no public URL"
openssl genrsa -out "$workdir/app.pem" 2048 2>/dev/null
{
  echo "SITE_ADDRESS=http://localhost:${port}"
  echo "BASE_URL=http://localhost:${port}"
  echo "HTTP_PORT=${port}"
  echo "HTTPS_PORT=$((port + 1))"
  echo "CADDY_HTTP_PORT=${port}"
  echo "CADDY_HTTPS_PORT=$((port + 1))"
  echo "POSTGRES_USER=worklog"
  echo "POSTGRES_PASSWORD=localcheck-local"
  echo "POSTGRES_DB=worklog"
  echo "DATABASE_URL=postgres://worklog:localcheck-local@postgres:5432/worklog?sslmode=disable"
  echo "GITHUB_CLIENT_ID=Iv1.localCheckClient"
  echo "GITHUB_CLIENT_SECRET=localcheck-oauth-secret"
  echo "GITHUB_APP_ID=424242"
  # Deliberately empty: this is the whole point of the check.
  echo "GITHUB_WEBHOOK_SECRET="
  printf 'GITHUB_APP_PRIVATE_KEY="'
  cat "$workdir/app.pem"
  printf '"\n'
  echo "GITHUB_API_URL=http://host.docker.internal:${stub_port}"
  echo "BACKUP_S3_URL="
} > "$env_file"
ok "webhook secret left empty on purpose"

docker compose --env-file "$env_file" -p "$project" up -d --build >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${port}/api/v1/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://localhost:${port}/api/v1/health" >/dev/null || die "stack never became healthy"
ok "stack healthy on :${port}"

step "OAuth still redirects to GitHub from localhost"
location=$(curl -s -o /dev/null -w '%{redirect_url}' "http://localhost:${port}/api/v1/auth/github/login")
case "$location" in
  https://github.com/login/oauth/authorize*redirect_uri=http%3A%2F%2Flocalhost*)
    ok "callback is a localhost URL, which the operator's own browser resolves" ;;
  *) die "unexpected sign-in redirect: $location" ;;
esac

step "Set up the workspace and connect the repository"
ENV_FILE="$env_file" COMPOSE_PROJECT="$project" ./bootstrap.sh sabari "Narayana" lab ENG >/dev/null
docker compose --env-file "$env_file" -p "$project" exec -T postgres \
  psql -U worklog -d worklog -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO app_user (github_id, github_login, name) VALUES (1, 'sabari', 'Sabari')
ON CONFLICT (github_id) DO NOTHING;
UPDATE membership m SET user_id = u.id FROM app_user u
WHERE lower(m.invited_login) = lower(u.github_login) AND m.user_id IS NULL;
INSERT INTO session (id, user_id, expires_at)
SELECT encode(digest('localcheck','sha256'),'hex'), u.id, now() + interval '1 hour'
FROM app_user u WHERE u.github_id = 1
ON CONFLICT (id) DO NOTHING;
SQL

GITHUB_API_URL="http://127.0.0.1:${stub_port}" \
  BASE_URL="http://localhost:${port}" \
  SESSION_TOKEN=localcheck \
  ./connect-repo.sh narayana/platform lab >/dev/null
ok "repository connected"

issue_key=$(curl -fsS -X POST "http://localhost:${port}/api/v1/w/lab/issues" \
  -H 'Cookie: ticket_session=localcheck' -H 'Content-Type: application/json' \
  -d '{"title":"Wire up sign-in"}' |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')
ok "created ${issue_key}"

step "preflight must not fail an install that simply has no webhook"
if ! output=$(ENV_FILE="$env_file" COMPOSE_PROJECT="$project" ./preflight.sh lab 2>&1); then
  printf '%s\n' "$output" | sed 's/^/   /'
  die "preflight failed a valid webhook-free install"
fi
printf '%s\n' "$output" | sed 's/^/   /'
ok "preflight passes, reporting the missing webhook as a note"

step "The PR must reach its issue with no webhook ever delivered"
# The worker reconciles at startup and hourly. Restarting is the honest way to
# trigger that pass without reaching into the database.
docker compose --env-file "$env_file" -p "$project" restart worker >/dev/null 2>&1

for _ in $(seq 1 45); do
  linked=$(curl -fsS "http://localhost:${port}/api/v1/w/lab/issues/${issue_key}/evidence" \
    -H 'Cookie: ticket_session=localcheck' |
    python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("pull_requests") or []))')
  [ "$linked" = "1" ] && break
  sleep 2
done
[ "${linked:-0}" = "1" ] || die "the PR never reached ${issue_key} through reconciliation"
ok "PR #11 linked itself to ${issue_key} by branch name"

deliveries=$(docker compose --env-file "$env_file" -p "$project" exec -T postgres \
  psql -U worklog -d worklog -tA -c "SELECT count(*) FROM github_event" | tr -d '[:space:]')
[ "$deliveries" = "0" ] || die "expected zero webhook deliveries, found ${deliveries}"
ok "zero webhook deliveries: this ran on reconciliation alone"

printf '\nA localhost install with no webhook works end to end.\n'
