#!/usr/bin/env bash
# Benchmarks the API endpoints the desktop app calls, against a live server.
# Usage: bench/api-bench.sh <base-url> <bearer-token> <workspace-slug> [runs]
# Prints p50/p95 total latency and time-to-first-byte per endpoint, plus
# payload size. Read-only: only GET requests.
set -euo pipefail
base="${1:?base url}"; token="${2:?token}"; slug="${3:?workspace slug}"; runs="${4:-10}"

measure() {
  local name="$1" path="$2"
  local totals=() ttfbs=() size=0
  for _ in $(seq 1 "$runs"); do
    out=$(curl -s -o /dev/null -w "%{time_total} %{time_starttransfer} %{size_download} %{http_code}" \
      -H "Authorization: Bearer $token" "$base$path")
    read -r t s b code <<<"$out"
    [ "$code" = 200 ] || { echo "$name -> HTTP $code"; return; }
    totals+=("$t"); ttfbs+=("$s"); size=$b
  done
  p() { printf '%s\n' "$@" | sort -n | awk -v q="$Q" '{a[NR]=$1} END{i=int(NR*q+0.5); if(i<1)i=1; printf "%.0f", a[i]*1000}'; }
  Q=0.5 p50=$(p "${totals[@]}"); Q=0.95 p95=$(p "${totals[@]}")
  Q=0.5 t50=$(p "${ttfbs[@]}")
  printf '%-28s p50 %5sms  p95 %5sms  ttfb50 %5sms  %7sB\n' "$name" "$p50" "$p95" "$t50" "$size"
}

echo "Runs per endpoint: $runs  Base: $base  Workspace: $slug"
measure health "/api/v1/health"
measure me "/api/v1/me"
measure projects "/api/v1/w/$slug/projects"
measure members "/api/v1/w/$slug/members"
measure labels "/api/v1/w/$slug/labels"
measure "issues (default 50)" "/api/v1/w/$slug/issues"
measure "issues limit=200" "/api/v1/w/$slug/issues?limit=200"
measure sprints "/api/v1/w/$slug/sprints"
first=$(curl -s -H "Authorization: Bearer $token" "$base/api/v1/w/$slug/issues?limit=1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["issues"][0]["key"])')
measure "issue $first" "/api/v1/w/$slug/issues/$first"
measure "comments $first" "/api/v1/w/$slug/issues/$first/comments"
measure "evidence $first" "/api/v1/w/$slug/issues/$first/evidence"
