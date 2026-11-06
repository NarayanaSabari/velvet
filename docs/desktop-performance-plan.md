# Desktop API performance: benchmark and plan

Date: 2026-11-06. Branch `main` at `71e6c4e` (desktop 0.4.1).

## How it was measured

- `bench/api-bench.sh <base> <token> <slug> [runs]`: read-only curl loop over every endpoint the desktop calls, reporting p50/p95 total time, time to first byte and payload size. Each run opens a new connection, which is what the desktop does today for every request burst after idle.
- `bench/seed-local.sh [n]`: seeds the disposable e2e stack (`e2e/stack-up.sh`, port 18399) with a `bench` workspace: 5 members, 3 projects, 6 labels, n issues with labels and 5 comments each, and a desktop API token.
- Production: `https://velvet.sabarinarayana.com`, desktop token from Keychain, workspace `personal` (1 issue). Production workspaces hold 0 to 1 issues today, so production numbers are pure network plus auth cost.

## Results

### Production, 10 runs, new connection each (what the app does)

| endpoint | p50 | p95 | bytes |
|---|---|---|---|
| health | 95ms | 214ms | 16 |
| me | 99ms | 377ms | 882 |
| projects | 108ms | 950ms | 657 |
| members | 102ms | 282ms | 243 |
| labels | 100ms | 166ms | 14 |
| issues (default 50) | 106ms | 237ms | 31 |
| issues limit=200 | 116ms | 769ms | 31 |
| sprints | 103ms | 179ms | 15 |

Connection anatomy on a fresh request: DNS 2ms, TCP 31ms, TLS done 64ms, first byte 90ms. A second request on the same keep-alive connection: 27ms first byte. So roughly 65 to 75ms of every cold request is handshake, 25 to 30ms is round trip plus server.

### Local stack, 500 issues, 20 runs (server cost only)

| endpoint | p50 | p95 | bytes |
|---|---|---|---|
| me | 1ms | 3ms | 411 |
| projects | 3ms | 4ms | 991 |
| members | 3ms | 5ms | 789 |
| labels | 3ms | 4ms | 809 |
| issues limit=50 | 6ms | 7ms | 67,565 |
| issues limit=200 | 6ms | 9ms | 271,438 |
| issue BEN-1 | 4ms | 4ms | 1,337 |
| comments BEN-1 | 4ms | 7ms | 2,900 |
| evidence BEN-1 | 4ms | 5ms | 47 |

### Local stack, 5000 issues, 15 runs

| endpoint | p50 | p95 |
|---|---|---|
| issues limit=200 | 10.1ms | 18.5ms |
| issues limit=200 status=todo | 4.3ms | 6.4ms |
| issues limit=200 search | 7.1ms | 9.7ms |
| issues limit=200 cursor page 2 | 7.0ms | 10.4ms |
| issues include_counts | 7.7ms | 8.1ms |
| members / labels | 1ms | 1.5ms |
| issue / comments | 1.4ms / 2.9ms | 2.1ms / 4.6ms |

### Compression

200 issues: 271,438 bytes plain, 12,744 bytes gzip (21x). Caddy already gzips. The desktop `reqwest` client is built without the `gzip` feature, so it never sends `Accept-Encoding` and always receives the plain body.

## Diagnosis

1. The server is not the bottleneck. Every query is under 10ms at 5000 issues. Auth adds three queries per request (token UPDATE, token SELECT, membership SELECT) but they cost about 1ms together.
2. The desktop pays the TLS handshake over and over. Each refresh runs 4 sequential requests (projects, members, labels, issues) and each issue select runs 3 (issue, comments, evidence). reqwest keeps connections alive, but the server or Caddy closes idle ones, and sequential calls still serialise 4 round trips: 4 x ~100ms = ~400ms on refresh, 3 x ~100ms = ~300ms on every row click, from one Mumbai-to-server trip. On a weak connection the p95s (770 to 950ms) multiply.
3. Issue list payload is 21x larger than it needs to be. At 200 issues that is 270KB per refresh, and every description is shipped though the list never shows it.
4. The assignee/labels/evidence rail waits for the issue detail fetch to finish even though the row already holds all of it.

## Plan, in order of payoff per line of code

### Phase 1: client transport (desktop only, no API change)

1. Enable `reqwest` `gzip` feature. One Cargo line. Cuts list payload 21x and is the biggest single win on slow links.
2. Parallelise independent requests. `refresh` runs projects, members, labels and issues concurrently; `select_issue` runs issue, comments and evidence concurrently. 4 serial RTTs become 1. Use `std::thread::scope` inside the existing `smol::unblock` so no async refactor.
3. Keep the connection warm: `pool_idle_timeout(None)` and `tcp_keepalive(60s)` on the client, plus HTTP/2 (`http2_prior_knowledge` not needed, ALPN does it; verify rustls h2 is on). Removes the 65ms handshake from most requests.
4. Render the selected issue from the row immediately, then overlay comments and evidence when they arrive. Removes the perceived 300ms click latency.

Expected: refresh from ~400ms to ~100 to 130ms, row click from ~300ms to ~0 perceived, ~100ms for comments. Verified with the same bench script plus a desktop-side timing log.

### Phase 2: API shape (small, additive)

5. `GET /w/{slug}/issues?fields=list` (or `?summary=true`) that omits `description`. Description is 60 to 70% of the list payload. Desktop and web list both benefit. Detail fetch already returns it.
6. `GET /w/{slug}/bootstrap` returning `{projects, members, labels}` in one response. Saves 2 RTTs on every refresh and workspace switch. Three cheap queries, one handler, one test.
7. Skip the token `last_used_at` UPDATE when it is already within the last minute: the query does that in SQL but still costs a round trip. Fold it into the SELECT with a `WITH` so auth is one query. ~0.5ms, low priority, do it only while touching that file.

### Phase 3: caching (only if Phase 1 and 2 leave a visible gap)

8. ETag on list and bootstrap responses, `If-None-Match` from the desktop, 304 on unchanged. Cheap on the server (hash of `max(updated_at)`, count). Good for the 6-hourly and manual refreshes.
9. Persist the last list and bootstrap payload to disk so the app paints instantly on launch and then refreshes. This is "stale while revalidate", not offline mode; writes stay online-only.

### Not planned

- Database indexes: all current queries are index-backed and under 10ms at 10x expected data.
- Server-side caching, Redis, or a CDN: nothing on the server is slow.
- Moving the server closer: real, but outside this codebase.

## Acceptance

- Re-run `bench/api-bench.sh` against production after Phase 1 to confirm no server regression.
- Add a `--timing` env flag to the desktop that logs each request's duration and the wall time of `refresh` and `select_issue`, and record before/after in `desktop/parity.md`.
- Connected desktop test on the local stack with 500 issues to cover the parallel paths and gzip decoding.
