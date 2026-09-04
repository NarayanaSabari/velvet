#!/usr/bin/env bash
#
# Walks the documented setup procedure from an empty stack and asserts the
# integration actually works at the end.
#
# The scripts having been exercised individually is not the same as the
# documented procedure producing a working system, which is the thing a new
# operator actually needs. This runs the README's steps in order against a
# stub GitHub, then delivers a signed webhook and checks that a pull request
# linked itself to an issue.
#
# A throwaway RSA key is generated at run time; nothing secret is committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

port="${SETUP_PORT:-8097}"
stub_port="${STUB_PORT:-8795}"
project="setupcheck"
env_file=".env.setupcheck"
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

# --- A stub GitHub, so the procedure can be walked without a real org --------
cat > "$workdir/stub.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, sys, time

REPO = {"id": 700123, "name": "platform", "full_name": "narayana/platform",
        "default_branch": "main", "owner": {"login": "narayana"}}
INSTALL = {"id": 55001122, "app_id": 424242, "account": {"login": "narayana"}}
TOKEN = {"token": "stub-installation-token",
         "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))}

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
            self._send([])
        else:
            self._send({"message": "Not Found"}, 404)

    def do_POST(self):
        if self.path.endswith("/access_tokens"):
            self._send(TOKEN, 201)
        else:
            self._send({"message": "Not Found"}, 404)

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY

python3 "$workdir/stub.py" "$stub_port" &
stub_pid=$!
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${stub_port}/repos/narayana/platform" >/dev/null 2>&1 && break
  sleep 0.5
done

step "Step 1: write .env.local the way the README describes"

# A throwaway key, generated here rather than committed. This is also the exact
# multi-line shape that breaks when someone forgets to quote it.
openssl genrsa -out "$workdir/app.pem" 2048 2>/dev/null

{
  echo "SITE_ADDRESS=http://localhost:${port}"
  echo "BASE_URL=http://localhost:${port}"
  echo "HTTP_PORT=${port}"
  echo "HTTPS_PORT=$((port + 1))"
  echo "CADDY_HTTP_PORT=${port}"
  echo "CADDY_HTTPS_PORT=$((port + 1))"
  echo "POSTGRES_USER=worklog"
  echo "POSTGRES_PASSWORD=setupcheck-local"
  echo "POSTGRES_DB=worklog"
  echo "DATABASE_URL=postgres://worklog:setupcheck-local@postgres:5432/worklog?sslmode=disable"
  echo "SESSION_SECRET=setupcheck-session-secret-at-least-32-chars"
  echo "GITHUB_CLIENT_ID=Iv1.setupCheckClient"
  echo "GITHUB_CLIENT_SECRET=setupcheck-oauth-secret"
  echo "GITHUB_APP_ID=424242"
  echo "GITHUB_WEBHOOK_SECRET=setupcheck-webhook-secret"
  printf 'GITHUB_APP_PRIVATE_KEY="'
  cat "$workdir/app.pem"
  printf '"\n'
  echo "BACKUP_S3_URL="
} > "$env_file"
ok "env written, private key quoted across multiple lines"

step "Step 2: bring the stack up"
docker compose --env-file "$env_file" -p "$project" up -d --build >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${port}/api/v1/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://localhost:${port}/api/v1/health" >/dev/null || die "stack never became healthy"
ok "stack healthy on :${port}"

step "Step 3: bootstrap the workspace and first admin"
ENV_FILE="$env_file" COMPOSE_PROJECT="$project" ./bootstrap.sh sabari "Narayana" lab ENG >/dev/null
ENV_FILE="$env_file" COMPOSE_PROJECT="$project" ./invite.sh priya member lab >/dev/null
ok "workspace created, two members invited"

# The operator would sign in through GitHub here; seed the session instead,
# since driving github.com is out of scope for a local check.
docker compose --env-file "$env_file" -p "$project" exec -T postgres \
  psql -U worklog -d worklog -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO app_user (github_id, github_login, name) VALUES (1, 'sabari', 'Sabari')
ON CONFLICT (github_id) DO NOTHING;
UPDATE membership m SET user_id = u.id FROM app_user u
WHERE lower(m.invited_login) = lower(u.github_login) AND m.user_id IS NULL;
INSERT INTO session (id, user_id, expires_at)
SELECT encode(digest('setupcheck','sha256'),'hex'), u.id, now() + interval '1 hour'
FROM app_user u WHERE u.github_id = 1
ON CONFLICT (id) DO NOTHING;
SQL

step "Step 4: connect the repository"
GITHUB_API_URL="http://127.0.0.1:${stub_port}" \
  BASE_URL="http://localhost:${port}" \
  SESSION_TOKEN=setupcheck \
  ./connect-repo.sh narayana/platform lab >/dev/null
ok "repository connected"

step "Step 5: preflight must report a clean configuration"
if ! output=$(ENV_FILE="$env_file" COMPOSE_PROJECT="$project" ./preflight.sh lab 2>&1); then
  printf '%s\n' "$output"
  die "preflight reported problems on a correctly configured stack"
fi
printf '%s\n' "$output" | sed 's/^/   /'
ok "every preflight check passed"

step "Step 6: a real signed webhook must link a PR to an issue"
issue_key=$(curl -fsS -X POST "http://localhost:${port}/api/v1/w/lab/issues" \
  -H 'Cookie: ticket_session=setupcheck' -H 'Content-Type: application/json' \
  -d '{"title":"Wire up sign-in"}' |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])')
ok "created ${issue_key}"

python3 - "$issue_key" > "$workdir/hook.json" <<'PY'
import json, sys
key = sys.argv[1].lower()
pr = {"number": 7, "title": "Wire up sign-in", "state": "open", "draft": False,
      "body": "", "additions": 40, "deletions": 5,
      "html_url": "https://github.com/narayana/platform/pull/7",
      "created_at": "2026-09-04T09:00:00Z", "updated_at": "2026-09-04T09:00:00Z",
      "merged_at": None, "user": {"login": "sabari"},
      "head": {"ref": f"sabari/{key}-wire-up-sign-in"}}
json.dump({"action": "opened", "number": 7, "pull_request": pr,
           "repository": {"id": 700123, "name": "platform",
                          "owner": {"login": "narayana"}}}, sys.stdout)
PY

sig=$(openssl dgst -sha256 -hmac 'setupcheck-webhook-secret' -hex < "$workdir/hook.json" | awk '{print $NF}')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${port}/webhooks/github" \
  -H 'X-GitHub-Event: pull_request' -H 'X-GitHub-Delivery: setupcheck-1' \
  -H "X-Hub-Signature-256: sha256=${sig}" -H 'Content-Type: application/json' \
  --data-binary @"$workdir/hook.json")
[ "$code" = "200" ] || die "webhook was refused (HTTP ${code})"
ok "webhook accepted"

for _ in $(seq 1 30); do
  linked=$(curl -fsS "http://localhost:${port}/api/v1/w/lab/issues/${issue_key}/evidence" \
    -H 'Cookie: ticket_session=setupcheck' |
    python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("pull_requests") or []))')
  [ "$linked" = "1" ] && break
  sleep 1
done
[ "${linked:-0}" = "1" ] || die "the pull request never linked itself to ${issue_key}"
ok "PR #7 linked itself to ${issue_key} by branch name"

status=$(curl -fsS "http://localhost:${port}/api/v1/w/lab/issues/${issue_key}" \
  -H 'Cookie: ticket_session=setupcheck' |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
[ "$status" = "backlog" ] || die "attaching a PR changed the status to ${status}"
ok "issue status untouched, as designed"

printf '\nThe documented setup produces a working integration.\n'
