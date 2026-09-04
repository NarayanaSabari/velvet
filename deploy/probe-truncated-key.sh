#!/usr/bin/env bash
# Verifies preflight.sh detects a truncated private key.
#
# An unquoted PEM in a .env file keeps only its first line, which is the most
# common setup mistake: the value looks present, so nothing complains until
# every signed GitHub call fails. This builds that broken shape and asserts the
# check catches it. No key material is involved; only the header line.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
out=.env.truncated-probe

grep -v '^GITHUB_APP' .env.demo > "$out"
{
  echo 'GITHUB_APP_ID=123456'
  # Header only, exactly what survives an unquoted multi-line value.
  printf 'GITHUB_APP_PRIVATE_KEY=-----%s RSA PRIVATE KEY-----\n' 'BEGIN'
} >> "$out"

result=$(ENV_FILE="$out" COMPOSE_PROJECT=worklogdemo ./preflight.sh lab 2>&1 || true)
rm -f "$out"

echo "$result" | grep -A1 'complete PEM' || true

if echo "$result" | grep -q 'FAIL  private key is not a complete PEM'; then
  echo
  echo "PASS: preflight caught the truncated key."
else
  echo
  echo "FAIL: preflight did not catch the truncated key." >&2
  exit 1
fi
