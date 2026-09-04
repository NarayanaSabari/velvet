# Work-Log Ticketing System - GitHub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach GitHub pull requests to issues as proof of work: receive webhooks, link PRs to issues by branch name or body reference, mirror commits and reviews onto the issue timeline, and reconcile anything the webhooks missed.

**Architecture:** The webhook endpoint does nothing but verify the signature, persist the raw payload, and return 200. A worker process drains a Postgres-backed job queue and does the real work: matching PRs to issues, upserting mirrored state, and recording activity. A periodic reconciler re-fetches from the GitHub REST API, because webhooks are missed in practice and a system that assumes otherwise is quietly wrong within a month.

**Tech Stack:** Go 1.26, Postgres 18, `pgx/v5`, `github.com/golang-jwt/jwt/v5` for GitHub App tokens, stdlib `net/http` for the GitHub client.

**Spec:** `docs/superpowers/specs/2026-09-04-worklog-ticketing-design.md`, section 5.

**Depends on:** `docs/superpowers/plans/2026-09-04-worklog-core-api.md` tasks 1-10 (schema, store, activity, server, testutil fixtures).

## Global Constraints

- Go module path: `github.com/NarayanaSabari/velvet-otter-lab/api`.
- **Attaching or merging a PR never changes issue status.** It records evidence and activity only. This is the core product decision of the whole feature; a task that violates it is wrong even if its tests pass.
- Every table carries `workspace_id` and every query filters on it.
- The webhook handler must not call GitHub, must not do matching, and must answer within milliseconds.
- Webhook deliveries are deduplicated by GitHub delivery ID. Redelivery must be a no-op.
- **Never write a private key, webhook secret, or token into a source file, a fixture, or a test.** Test keys are generated in memory at test start. Never log or persist an installation token.
- Tests run against real Postgres via testcontainers and against a stubbed GitHub HTTP server. Never call the real GitHub API in a test.
- Commit after every task. Never add tool attribution or `Co-Authored-By` trailers to commit messages.

---

### Task 1: GitHub schema and the job queue

**Files:**
- Create: `api/internal/db/migrations/0002_github.sql`, `api/internal/store/job.go`, `api/internal/store/job_test.go`

**Interfaces:**
- Consumes: `store.Store`, `store.InTx` from plan 1.
- Produces:
  - `store.Job{ID int64; Kind string; Payload []byte; Attempts int}`
  - `(*Store).EnqueueJob(ctx context.Context, tx pgx.Tx, kind string, payload any) error` - takes a `tx` so a job is enqueued in the same transaction as the row that justifies it.
  - `(*Store).ClaimJob(ctx context.Context) (Job, error)` - returns `ErrNotFound` when the queue is empty.
  - `(*Store).CompleteJob(ctx context.Context, id int64) error`
  - `(*Store).FailJob(ctx context.Context, id int64, reason string) error` - exponential backoff, dead-letter after 5 attempts.

- [ ] **Step 1: Write the migration**

`api/internal/db/migrations/0002_github.sql`:

```sql
CREATE TABLE github_installation (
    id              bigint PRIMARY KEY,
    account_login   text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    suspended_at    timestamptz
);

CREATE TABLE repo (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    installation_id bigint NOT NULL REFERENCES github_installation(id) ON DELETE CASCADE,
    github_id       bigint NOT NULL UNIQUE,
    owner           text NOT NULL,
    name            text NOT NULL,
    default_branch  text NOT NULL DEFAULT 'main',
    synced_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repo_workspace_idx ON repo (workspace_id);

CREATE TYPE pr_state AS ENUM ('open', 'closed', 'merged');

CREATE TABLE pull_request (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    repo_id      uuid NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    number       integer NOT NULL,
    title        text NOT NULL,
    state        pr_state NOT NULL,
    draft        boolean NOT NULL DEFAULT false,
    author_login text NOT NULL DEFAULT '',
    author_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
    head_ref     text NOT NULL DEFAULT '',
    body         text NOT NULL DEFAULT '',
    additions    integer NOT NULL DEFAULT 0,
    deletions    integer NOT NULL DEFAULT 0,
    html_url     text NOT NULL DEFAULT '',
    merged_at    timestamptz,
    closed_at    timestamptz,
    gh_created_at timestamptz,
    gh_updated_at timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repo_id, number)
);
CREATE INDEX pull_request_workspace_idx ON pull_request (workspace_id, gh_updated_at DESC);

CREATE TYPE pr_link_source AS ENUM ('branch', 'body', 'manual');

CREATE TABLE pr_link (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    pull_request_id uuid NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
    issue_id        uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    link_source     pr_link_source NOT NULL,
    closing         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pull_request_id, issue_id)
);
CREATE INDEX pr_link_issue_idx ON pr_link (issue_id);

CREATE TABLE pr_review (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    pull_request_id uuid NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
    github_id       bigint NOT NULL UNIQUE,
    reviewer_login  text NOT NULL,
    reviewer_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    state           text NOT NULL,
    submitted_at    timestamptz NOT NULL
);
CREATE INDEX pr_review_pr_idx ON pr_review (pull_request_id, submitted_at);

CREATE TABLE commit_ref (
    sha          text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    repo_id      uuid NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id     uuid REFERENCES issue(id) ON DELETE SET NULL,
    branch       text NOT NULL DEFAULT '',
    message      text NOT NULL DEFAULT '',
    author_login text NOT NULL DEFAULT '',
    html_url     text NOT NULL DEFAULT '',
    committed_at timestamptz NOT NULL
);
CREATE INDEX commit_ref_issue_idx ON commit_ref (issue_id, committed_at DESC)
    WHERE issue_id IS NOT NULL;

CREATE TABLE github_event (
    delivery_id  text PRIMARY KEY,
    event_type   text NOT NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX github_event_unprocessed_idx ON github_event (received_at)
    WHERE processed_at IS NULL;

CREATE TABLE job (
    id          bigserial PRIMARY KEY,
    kind        text NOT NULL,
    payload     jsonb NOT NULL,
    run_after   timestamptz NOT NULL DEFAULT now(),
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    dead        boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_ready_idx ON job (run_after) WHERE NOT dead;
```

- [ ] **Step 2: Write the failing queue test**

`api/internal/store/job_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestClaimJobReturnsEachJobOnce(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		return st.EnqueueJob(ctx, tx, "process_delivery", map[string]any{"delivery_id": "d1"})
	}))

	job, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	require.Equal(t, "process_delivery", job.Kind)

	// A second claim before completion must find nothing: two workers must
	// never process the same delivery.
	_, err = st.ClaimJob(ctx)
	require.ErrorIs(t, err, store.ErrNotFound)

	require.NoError(t, st.CompleteJob(ctx, job.ID))

	var remaining int
	require.NoError(t, st.Pool().QueryRow(ctx, `SELECT count(*) FROM job`).Scan(&remaining))
	require.Equal(t, 0, remaining)
}

func TestFailedJobBacksOffThenDies(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		return st.EnqueueJob(ctx, tx, "process_delivery", map[string]any{"delivery_id": "d1"})
	}))

	job, err := st.ClaimJob(ctx)
	require.NoError(t, err)
	require.NoError(t, st.FailJob(ctx, job.ID, "boom"))

	// Backoff means it is not immediately claimable again.
	_, err = st.ClaimJob(ctx)
	require.ErrorIs(t, err, store.ErrNotFound)

	// After five failures it is dead-lettered rather than retried forever.
	_, err = st.Pool().Exec(ctx,
		`UPDATE job SET attempts = 5, run_after = now() WHERE id = $1`, job.ID)
	require.NoError(t, err)

	job, err = st.ClaimJob(ctx)
	require.NoError(t, err)
	require.NoError(t, st.FailJob(ctx, job.ID, "boom again"))

	var dead bool
	require.NoError(t, st.Pool().QueryRow(ctx,
		`SELECT dead FROM job WHERE id = $1`, job.ID).Scan(&dead))
	require.True(t, dead)
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && go test ./internal/store/ -run Job`
Expected: FAIL - undefined `store.EnqueueJob`.

- [ ] **Step 4: Implement the queue**

`api/internal/store/job.go`. `ClaimJob` uses `FOR UPDATE SKIP LOCKED` so multiple workers never contend for the same row:

```go
func (s *Store) ClaimJob(ctx context.Context) (Job, error) {
	var j Job
	err := s.pool.QueryRow(ctx, `
		UPDATE job SET run_after = now() + interval '5 minutes', attempts = attempts + 1
		WHERE id = (
			SELECT id FROM job
			WHERE NOT dead AND run_after <= now()
			ORDER BY run_after
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING id, kind, payload, attempts`).
		Scan(&j.ID, &j.Kind, &j.Payload, &j.Attempts)
	return j, mapErr(err)
}
```

The claim pushes `run_after` five minutes out, so a worker that crashes mid-job releases its work automatically rather than losing it.

`FailJob` sets `run_after = now() + (2 ^ attempts) seconds`, capped at an hour, and sets `dead = true` once `attempts >= 5`.

`CompleteJob` deletes the row.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go test ./internal/store/ -run Job -v`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "Add GitHub schema and Postgres-backed job queue"
```

---

### Task 2: Webhook receiver

**Files:**
- Create: `api/internal/api/webhook.go`, `api/internal/api/webhook_test.go`, `api/internal/store/github_event.go`
- Modify: `api/internal/api/server.go`, `api/internal/config/config.go`

**Interfaces:**
- Consumes: `store.EnqueueJob`, `store.InTx`.
- Produces:
  - `(*Store).RecordDelivery(ctx context.Context, deliveryID, eventType string, payload []byte) (isNew bool, err error)` - inserts the raw payload and enqueues a `process_delivery` job in one transaction; returns `false` when the delivery was already seen.
  - Route `POST /webhooks/github`, unauthenticated but HMAC-verified.
  - `config.Config.GitHubWebhookSecret`, `GitHubAppID`, `GitHubAppPrivateKey` added to the loader.

- [ ] **Step 1: Write the failing test**

`api/internal/api/webhook_test.go`:

```go
package api_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// A test-only value, not a credential: it never leaves this process and is not
// the secret configured for any real GitHub App.
const testWebhookSecret = "test-only-webhook-value"

func signedRequest(t *testing.T, event, deliveryID, body string) *http.Request {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(testWebhookSecret))
	mac.Write([]byte(body))
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", deliveryID)
	req.Header.Set("X-Hub-Signature-256", sig)
	return req
}

func TestWebhookRejectsABadSignature(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	req := signedRequest(t, "pull_request", "d1", `{"action":"opened"}`)
	req.Header.Set("X-Hub-Signature-256", "sha256=deadbeef")

	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM github_event`).Scan(&count))
	require.Equal(t, 0, count, "an unverified payload must never be stored")
}

func TestWebhookStoresAndEnqueues(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "d1", `{"action":"opened"}`))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var eventType string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT event_type FROM github_event WHERE delivery_id = 'd1'`).Scan(&eventType))
	require.Equal(t, "pull_request", eventType)

	var jobs int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job WHERE kind = 'process_delivery'`).Scan(&jobs))
	require.Equal(t, 1, jobs)
}

func TestRedeliveryIsANoOp(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "same-id", `{"action":"opened"}`))
		require.Equal(t, http.StatusOK, rec.Code,
			"a redelivery must still answer 200 so GitHub stops retrying")
	}

	var events, jobs int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM github_event`).Scan(&events))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job`).Scan(&jobs))
	require.Equal(t, 1, events)
	require.Equal(t, 1, jobs, "a duplicate delivery must not enqueue a second job")
}

func TestWebhookRejectsAnOversizedBody(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	huge := `{"data":"` + strings.Repeat("x", 30<<20) + `"}`
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "big", huge))
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
}
```

Add `testutil.NewFixtureWithWebhookSecret(t *testing.T, secret string) *Fixture` to `api/internal/testutil/fixtures.go`, identical to `NewFixture` but setting `cfg.GitHubWebhookSecret`. Refactor `NewFixture` to call it with an empty secret so there is one construction path.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Webhook`
Expected: FAIL - route not found.

- [ ] **Step 3: Implement the receiver**

`api/internal/api/webhook.go`:

```go
package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
)

const maxWebhookBody = 25 << 20 // GitHub's documented ceiling.

func (s *Server) handleGitHubWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBody+1))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "could not read the body")
		return
	}
	if len(body) > maxWebhookBody {
		WriteError(w, http.StatusRequestEntityTooLarge, "too_large", "payload too large")
		return
	}

	// Verify before parsing: an unverified payload is attacker-controlled and
	// must not reach the database or the JSON decoder's edge cases.
	if !validSignature(s.cfg.GitHubWebhookSecret, body, r.Header.Get("X-Hub-Signature-256")) {
		WriteError(w, http.StatusUnauthorized, "bad_signature", "signature did not verify")
		return
	}

	deliveryID := r.Header.Get("X-GitHub-Delivery")
	eventType := r.Header.Get("X-GitHub-Event")
	if deliveryID == "" || eventType == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "missing GitHub headers")
		return
	}

	isNew, err := s.store.RecordDelivery(r.Context(), deliveryID, eventType, body)
	if err != nil {
		// 500 makes GitHub retry, which is what we want when storage failed.
		slog.Error("record delivery", "err", err, "delivery", deliveryID)
		WriteError(w, http.StatusInternalServerError, "internal", "could not accept the delivery")
		return
	}

	// A duplicate still answers 200, because GitHub should stop retrying
	// something already accepted.
	WriteJSON(w, http.StatusOK, map[string]any{"accepted": true, "duplicate": !isNew})
}

// validSignature compares in constant time. A plain == would leak the correct
// prefix length through timing.
func validSignature(secret string, body []byte, header string) bool {
	if secret == "" || header == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(header))
}
```

`api/internal/store/github_event.go`:

```go
package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// RecordDelivery persists the raw payload and enqueues its job atomically, so
// a stored delivery always has a job and an enqueued job always has a payload.
func (s *Store) RecordDelivery(ctx context.Context, deliveryID, eventType string, payload []byte) (bool, error) {
	isNew := false
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO github_event (delivery_id, event_type, payload)
			VALUES ($1, $2, $3)
			ON CONFLICT (delivery_id) DO NOTHING`, deliveryID, eventType, payload)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		isNew = true
		return s.EnqueueJob(ctx, tx, "process_delivery",
			map[string]any{"delivery_id": deliveryID})
	})
	return isNew, err
}
```

Register the route outside the `/api/v1` group: `mux.HandleFunc("POST /webhooks/github", s.handleGitHubWebhook)`.

Add `GitHubWebhookSecret`, `GitHubAppID`, and `GitHubAppPrivateKey` to `config.Config` and `Load`, reading `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY`. None are required at load time, so the API still boots before GitHub is configured. Add the variable names to `.env.example` with empty values.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Webhook -v`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "Add HMAC-verified GitHub webhook receiver with delivery dedup"
```

---

### Task 3: GitHub App client

**Files:**
- Create: `api/internal/github/client.go`, `api/internal/github/auth.go`, `api/internal/github/client_test.go`

**Interfaces:**
- Consumes: `config.Config`.
- Produces:
  - `github.NewClient(appID string, privateKeyPEM []byte, baseURL string) (*github.Client, error)` - `baseURL` defaults to `https://api.github.com` and exists so tests can point at a stub.
  - `(*Client).InstallationToken(ctx context.Context, installationID int64) (string, error)` - cached until 5 minutes before expiry.
  - `(*Client).ListPullRequests(ctx context.Context, installationID int64, owner, repo string, since time.Time) ([]PullRequest, error)`
  - `(*Client).GetPullRequest(ctx context.Context, installationID int64, owner, repo string, number int) (PullRequest, error)`
  - `(*Client).ListReviews(ctx context.Context, installationID int64, owner, repo string, number int) ([]Review, error)`
  - `github.PullRequest`, `github.Review`, `github.Repository` structs mirroring the API fields the schema stores.
  - `github.ErrRateLimited` carrying the reset time.

- [ ] **Step 1: Write the failing test**

The test needs an RSA key to sign the App JWT. **Generate it in memory at test start.** Never paste a PEM into a source file: a committed private key is a credential in version control forever, even when it was only ever meant for a stub, and it will trip the repository's credential guard.

`api/internal/github/client_test.go`:

```go
package github_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
)

// testKeyPEM generates a throwaway RSA key for this process only. Generating
// beats committing: nothing secret ever reaches the repository.
func testKeyPEM(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

func TestInstallationTokenIsCached(t *testing.T) {
	var mints int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			atomic.AddInt32(&mints, 1)
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339),
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	for i := 0; i < 3; i++ {
		tok, err := c.InstallationToken(context.Background(), 99)
		require.NoError(t, err)
		require.Equal(t, "stub-installation-token", tok)
	}
	require.Equal(t, int32(1), atomic.LoadInt32(&mints),
		"a cached token must not be re-minted on every call")
}

func TestListPullRequestsParsesTheAPIShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
		case "/repos/acme/widgets/pulls":
			require.Equal(t, "Bearer stub-installation-token", r.Header.Get("Authorization"))
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": 42, "title": "Fix auth", "state": "closed", "draft": false,
				"body": "closes ENG-7", "additions": 10, "deletions": 2,
				"html_url":   "https://github.com/acme/widgets/pull/42",
				"merged_at":  "2026-09-01T10:00:00Z",
				"created_at": "2026-08-31T10:00:00Z",
				"updated_at": "2026-09-01T10:00:00Z",
				"user":       map[string]any{"login": "sabari"},
				"head":       map[string]any{"ref": "sabari/eng-7-fix-auth"},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	prs, err := c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.NoError(t, err)
	require.Len(t, prs, 1)
	require.Equal(t, 42, prs[0].Number)
	require.Equal(t, "merged", prs[0].State,
		"a closed PR with merged_at set must normalise to merged")
	require.Equal(t, "sabari/eng-7-fix-auth", prs[0].HeadRef)
	require.Equal(t, "sabari", prs[0].AuthorLogin)
}

func TestPaginationFollowsLinkHeaders(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		page := r.URL.Query().Get("page")
		if page == "" || page == "1" {
			w.Header().Set("Link", `<`+srv.URL+`/repos/acme/widgets/pulls?page=2>; rel="next"`)
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": 1, "title": "One", "state": "open",
				"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
				"user": map[string]any{"login": "a"}, "head": map[string]any{"ref": "b1"}}})
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{{
			"number": 2, "title": "Two", "state": "open",
			"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
			"user": map[string]any{"login": "a"}, "head": map[string]any{"ref": "b2"}}})
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	prs, err := c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.NoError(t, err)
	require.Len(t, prs, 2, "a second page must not be silently dropped")
}

func TestRateLimitIsReportedNotSwallowed(t *testing.T) {
	reset := time.Now().Add(30 * time.Minute)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c, err := github.NewClient("123", testKeyPEM(t), srv.URL)
	require.NoError(t, err)

	_, err = c.ListPullRequests(context.Background(), 99, "acme", "widgets", time.Time{})
	require.ErrorIs(t, err, github.ErrRateLimited)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/github/...`
Expected: FAIL - package does not exist.

- [ ] **Step 3: Implement the client**

`api/internal/github/auth.go` mints the App JWT (RS256, `iss` = app id, 9-minute expiry, `iat` backdated 60 seconds to tolerate clock skew) and exchanges it for an installation token, caching per installation behind a mutex until 5 minutes before expiry.

`api/internal/github/client.go` implements the four calls. Requirements:

- Set `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.
- Follow `Link: rel="next"` pagination to completion.
- Normalise state: `merged_at != nil` means `merged`, otherwise the API's `open` or `closed`.
- Return `ErrRateLimited` when a 403 or 429 carries `X-RateLimit-Remaining: 0`, wrapping the reset time:

```go
var ErrRateLimited = errors.New("github: rate limited")

type RateLimitError struct {
	ResetAt time.Time
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("github: rate limited until %s", e.ResetAt.Format(time.RFC3339))
}

func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }
```

- Send `If-None-Match` when the caller supplies an ETag and treat 304 as "unchanged", so unchanged PRs cost nothing against the 5,000/hour budget.
- Use a 30-second client timeout.
- Never log the installation token, and never include it in an error message.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/github/... -v`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "Add GitHub App client with token caching and rate-limit handling"
```

---

### Task 4: PR-to-issue matching

**Files:**
- Create: `api/internal/linker/linker.go`, `api/internal/linker/linker_test.go`

**Interfaces:**
- Consumes: nothing outside the standard library. This package is deliberately pure so the matching rules can be tested exhaustively without a database.
- Produces:
  - `linker.Match{Key string; Source string; Closing bool}` where `Source` is `branch` or `body`.
  - `linker.Find(prefix, branch, title, body string) []linker.Match` - returns every distinct issue key referenced, branch matches first.

- [ ] **Step 1: Write the failing test**

`api/internal/linker/linker_test.go`:

```go
package linker_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/linker"
)

func TestFindMatchesBranchNames(t *testing.T) {
	cases := []struct{ branch, want string }{
		{"sabari/eng-142-fix-auth", "ENG-142"},
		{"ENG-7", "ENG-7"},
		{"feature/ENG-99-thing", "ENG-99"},
		{"eng-1", "ENG-1"},
	}
	for _, c := range cases {
		got := linker.Find("ENG", c.branch, "", "")
		require.Len(t, got, 1, "branch %q", c.branch)
		require.Equal(t, c.want, got[0].Key)
		require.Equal(t, "branch", got[0].Source)
		require.False(t, got[0].Closing, "a branch name never implies closing")
	}
}

func TestFindIgnoresLookalikeBranches(t *testing.T) {
	for _, branch := range []string{
		"main",
		"strengthen-auth",       // contains "eng" inside a word
		"sabari/engine-rewrite", // "engine", not a key
		"eng-",                  // no number
		"release/v1.2.3",
	} {
		require.Empty(t, linker.Find("ENG", branch, "", ""), "branch %q", branch)
	}
}

func TestClosingKeywordsAreDetected(t *testing.T) {
	for _, body := range []string{
		"closes ENG-7", "Closes ENG-7", "fixes ENG-7", "resolved ENG-7",
		"This closes ENG-7 finally.",
	} {
		got := linker.Find("ENG", "", "", body)
		require.Len(t, got, 1, "body %q", body)
		require.True(t, got[0].Closing, "body %q must be closing", body)
	}
}

func TestBareMentionIsNotClosing(t *testing.T) {
	got := linker.Find("ENG", "", "", "Related to ENG-7, see also the design doc.")
	require.Len(t, got, 1)
	require.Equal(t, "ENG-7", got[0].Key)
	require.False(t, got[0].Closing,
		"a bare mention links without implying the issue is finished")
}

func TestBranchMatchWinsOverBody(t *testing.T) {
	got := linker.Find("ENG", "sabari/eng-1-thing", "", "also mentions ENG-2")
	require.Len(t, got, 2)
	require.Equal(t, "ENG-1", got[0].Key)
	require.Equal(t, "branch", got[0].Source)
	require.Equal(t, "ENG-2", got[1].Key)
	require.Equal(t, "body", got[1].Source)
}

func TestOnePRCanCloseSeveralIssues(t *testing.T) {
	got := linker.Find("ENG", "", "", "closes ENG-1 and closes ENG-2")
	require.Len(t, got, 2)
	require.True(t, got[0].Closing)
	require.True(t, got[1].Closing)
}

func TestTheSameKeyIsNotDuplicated(t *testing.T) {
	got := linker.Find("ENG", "sabari/eng-1-thing", "ENG-1 in the title", "closes ENG-1")
	require.Len(t, got, 1)
	require.Equal(t, "ENG-1", got[0].Key)
	require.Equal(t, "branch", got[0].Source, "the first source found wins")
	require.True(t, got[0].Closing,
		"a closing keyword anywhere still marks the link closing")
}

func TestAdjacentNumbersDoNotBleed(t *testing.T) {
	got := linker.Find("ENG", "", "", "ENG-12 and ENG-1 are different issues")
	require.Len(t, got, 2)
	require.Equal(t, "ENG-12", got[0].Key)
	require.Equal(t, "ENG-1", got[1].Key)
}

func TestNoMatchReturnsNothing(t *testing.T) {
	require.Empty(t, linker.Find("ENG", "main", "Bump deps", "Routine dependency bump."))
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/linker/...`
Expected: FAIL - package does not exist.

- [ ] **Step 3: Implement the matcher**

`api/internal/linker/linker.go`:

```go
// Package linker finds the issue keys a pull request refers to. It is pure so
// that the matching rules, which are the part users notice when they are
// wrong, can be tested exhaustively without a database.
package linker

import (
	"fmt"
	"regexp"
	"strings"
)

type Match struct {
	Key     string `json:"key"`
	Source  string `json:"source"`
	Closing bool   `json:"closing"`
}

var closingWords = regexp.MustCompile(
	`(?i)\b(close[sd]?|fixe?[sd]?|resolve[sd]?)\s+$`)

// Find returns every distinct issue key referenced by a pull request. Branch
// matches come first because a branch name is deliberate, whereas prose may
// mention an issue in passing.
func Find(prefix, branch, title, body string) []Match {
	// \b around the whole token stops "strengthen" matching prefix ENG and
	// stops ENG-1 swallowing the 2 of ENG-12.
	keyRe := regexp.MustCompile(
		fmt.Sprintf(`(?i)\b(%s)-(\d+)\b`, regexp.QuoteMeta(prefix)))

	var out []Match
	index := map[string]int{}

	add := func(key, source string, closing bool) {
		key = strings.ToUpper(key)
		if i, seen := index[key]; seen {
			// A closing keyword anywhere wins, but the first source stands.
			if closing {
				out[i].Closing = true
			}
			return
		}
		index[key] = len(out)
		out = append(out, Match{Key: key, Source: source, Closing: closing})
	}

	for _, m := range keyRe.FindAllStringIndex(branch, -1) {
		add(branch[m[0]:m[1]], "branch", false)
	}

	for _, text := range []string{title, body} {
		for _, m := range keyRe.FindAllStringIndex(text, -1) {
			closing := closingWords.MatchString(text[:m[0]])
			add(text[m[0]:m[1]], "body", closing)
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/linker/... -v`
Expected: PASS, all nine tests.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "Add pure PR-to-issue key matcher with closing-keyword detection"
```

---

### Task 5: The worker and delivery processing

**Files:**
- Create: `api/internal/worker/worker.go`, `api/internal/worker/pull_request.go`, `api/internal/worker/push.go`, `api/internal/worker/review.go`, `api/internal/worker/installation.go`, `api/internal/worker/worker_test.go`, `api/internal/store/pull_request.go`, `api/internal/testdata/github/*.json`
- Modify: `api/cmd/ticket/main.go`

**Interfaces:**
- Consumes: `store`, `github.Client`, `linker.Find`.
- Produces:
  - `worker.New(st *store.Store, gh *github.Client) *worker.Worker`
  - `(*Worker).Run(ctx context.Context) error` - claims jobs until the context is cancelled.
  - `(*Worker).ProcessOnce(ctx context.Context) (bool, error)` - processes at most one job; returns `false` when the queue is empty. Tests drive this rather than `Run`, so no test depends on a sleep.
  - `(*Store).UpsertPullRequest(ctx, in store.UpsertPRInput) (store.PullRequest, error)`
  - `(*Store).LinkPR(ctx, workspaceID, prID, issueID uuid.UUID, source string, closing bool, actorID *uuid.UUID) (bool, error)` - returns whether a new link was created, and records `attached_pr` activity only when it was.
  - `(*Store).UnlinkedPullRequests(ctx, workspaceID uuid.UUID, limit int) ([]PullRequest, error)`
  - `(*Store).IssueIDByKey(ctx, workspaceID uuid.UUID, key string) (uuid.UUID, error)`

- [ ] **Step 1: Capture fixture payloads**

Create `api/internal/testdata/github/pull_request.opened.json`, `pull_request.merged.json`, `pull_request.closed_unmerged.json`, `push.json`, and `pull_request_review.submitted.json`.

Use real GitHub payload shapes taken from GitHub's webhook documentation rather than invented fields, because a payload that does not match reality tests nothing. Each must contain a `repository.id` of `555` to match the repo the tests insert. The PR payloads must carry `head.ref` of `sabari/eng-1-fix-auth`, plus `body`, `merged_at`, `additions`, `deletions`, and `updated_at`. `pull_request.merged.json` must have a strictly later `updated_at` than `pull_request.opened.json`, since the out-of-order test depends on that ordering being real.

- [ ] **Step 2: Write the failing worker test**

`api/internal/worker/worker_test.go`:

```go
package worker_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

// deliver stores a fixture payload as a delivery and drains the queue, which
// is the same path a real webhook takes.
func deliver(t *testing.T, f *testutil.Fixture, w *worker.Worker, event, fixture, deliveryID string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "testdata", "github", fixture))
	require.NoError(t, err)

	_, err = f.Store.RecordDelivery(t.Context(), deliveryID, event, body)
	require.NoError(t, err)

	for {
		did, err := w.ProcessOnce(t.Context())
		require.NoError(t, err)
		if !did {
			return
		}
	}
}

func TestOpenedPRLinksToIssueByBranch(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth") // becomes ENG-1
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// The fixture's head.ref is "sabari/eng-1-fix-auth".
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	var source string
	var closing bool
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT link_source::text, closing FROM pr_link WHERE issue_id = $1`,
		issue.ID).Scan(&source, &closing))
	require.Equal(t, "branch", source)
	require.False(t, closing)
}

func TestPRNeverChangesIssueStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d2")

	var status string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT status::text FROM issue WHERE id = $1`, issue.ID).Scan(&status))
	require.Equal(t, "backlog", status,
		"merging a PR records evidence; only a human changes status")
}

func TestMergedPRRecordsAttachedActivityOnce(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d2")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbAttachedPR, issue.ID).Scan(&count))
	require.Equal(t, 1, count,
		"a second event for the same PR must not re-announce the attachment")

	var state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT state::text FROM pull_request WHERE number = 42`).Scan(&state))
	require.Equal(t, "merged", state)
}

func TestUnmatchedPRIsStoredAndListedAsUnlinked(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// No issue exists, so nothing can match.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	prs, err := f.Store.UnlinkedPullRequests(t.Context(), f.WorkspaceID, 10)
	require.NoError(t, err)
	require.Len(t, prs, 1,
		"an unmatched PR stays visible rather than vanishing")
	require.Equal(t, 42, prs[0].Number)
}

func TestDeliveryForAnUnknownRepoIsIgnoredNotFatal(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	// No repo linked at all: the delivery cannot be attributed to a workspace.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	var prs, dead int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&prs))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job WHERE dead`).Scan(&dead))
	require.Equal(t, 0, prs)
	require.Equal(t, 0, dead, "an unattributable delivery is dropped, not retried forever")
}

func TestPushRecordsCommitsAgainstTheBranchIssue(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "push", "push.json", "d1")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM commit_ref WHERE issue_id = $1`, issue.ID).Scan(&count))
	require.Greater(t, count, 0)
}

func TestReviewIsMirroredOntoThePR(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")
	deliver(t, f, w, "pull_request_review", "pull_request_review.submitted.json", "d2")

	var reviewer, state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT reviewer_login, state FROM pr_review`).Scan(&reviewer, &state))
	require.NotEmpty(t, reviewer,
		"a reviewer's work belongs in the record too, not just the author's")
	require.NotEmpty(t, state)
}

func TestReplayingADeliveryChangesNothing(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d1")

	snapshot := func() [3]int {
		var s [3]int
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&s[0]))
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&s[1]))
		require.NoError(t, f.Pool.QueryRow(t.Context(),
			`SELECT count(*) FROM activity WHERE verb = 'attached_pr'`).Scan(&s[2]))
		return s
	}
	before := snapshot()

	// Same payload, different delivery id: GitHub does this after an outage.
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d2")

	require.Equal(t, before, snapshot(), "reprocessing must be idempotent")
}

func TestOutOfOrderEventsDoNotResurrectStaleState(t *testing.T) {
	f := testutil.NewFixture(t)
	w := testutil.NewWorker(t, f, stubGitHub(t))

	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	// Merge arrives first, then the older "opened" event.
	deliver(t, f, w, "pull_request", "pull_request.merged.json", "d1")
	deliver(t, f, w, "pull_request", "pull_request.opened.json", "d2")

	var state string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT state::text FROM pull_request WHERE number = 42`).Scan(&state))
	require.Equal(t, "merged", state,
		"an older event must not overwrite newer state")
}

// stubGitHub answers the few REST calls the worker makes during these tests.
// Webhook processing should not need GitHub at all; this exists so a stray
// call fails loudly in the test rather than reaching the network.
func stubGitHub(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	t.Cleanup(srv.Close)
	return srv
}
```

Add these helpers to `api/internal/testutil/fixtures.go`:
- `CreateIssue(t *testing.T, f *Fixture, title string) store.Issue`
- `LinkRepo(t *testing.T, f *Fixture, githubID int64, owner, name string)` - inserts a `github_installation` with id 99 and a `repo` row bound to the fixture workspace.
- `NewWorker(t *testing.T, f *Fixture, stub *httptest.Server) *worker.Worker` - builds a `github.Client` pointed at the stub, using a key generated in memory.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && go test ./internal/worker/...`
Expected: FAIL - package does not exist.

- [ ] **Step 4: Implement the PR store**

`api/internal/store/pull_request.go`. `UpsertPullRequest` guards against stale events:

```sql
INSERT INTO pull_request (workspace_id, repo_id, number, title, state, draft,
    author_login, head_ref, body, additions, deletions, html_url,
    merged_at, closed_at, gh_created_at, gh_updated_at)
VALUES (...)
ON CONFLICT (repo_id, number) DO UPDATE SET
    title = EXCLUDED.title, state = EXCLUDED.state, draft = EXCLUDED.draft,
    body = EXCLUDED.body, additions = EXCLUDED.additions,
    deletions = EXCLUDED.deletions, merged_at = EXCLUDED.merged_at,
    closed_at = EXCLUDED.closed_at, gh_updated_at = EXCLUDED.gh_updated_at,
    updated_at = now()
WHERE EXCLUDED.gh_updated_at >= pull_request.gh_updated_at
RETURNING ...
```

The `WHERE` on the `DO UPDATE` is what makes out-of-order delivery safe: an older event simply does not apply. When the update is skipped the `RETURNING` yields no row, so re-select the existing row rather than treating it as an error.

`LinkPR` inserts with `ON CONFLICT (pull_request_id, issue_id) DO NOTHING`, and records `VerbAttachedPR` activity only when `RowsAffected() == 1`, in the same transaction. The activity's `TargetID` is the issue, so it appears on the issue's timeline, with the PR number and URL in the metadata.

- [ ] **Step 5: Implement the worker**

`api/internal/worker/worker.go` claims a job, dispatches on `kind`, marks `github_event.processed_at`, and completes or fails the job. An event type the worker does not handle is completed rather than failed, so an unexpected subscription cannot fill the dead-letter queue.

`pull_request.go`: resolve the repo by `repository.id`. If no repo row matches, complete the job and return: the delivery cannot be attributed to a workspace, and retrying will never change that. Otherwise upsert the PR, run `linker.Find(workspacePrefix, headRef, title, body)`, resolve each key with `IssueIDByKey`, and `LinkPR` each hit. Keys that resolve to nothing are skipped silently; the PR remains visible through `UnlinkedPullRequests`.

**Do not change issue status anywhere in this package.** Merging records evidence and nothing more.

`push.go`: for each commit, match the branch with `linker.Find`, and insert `commit_ref` with `ON CONFLICT (sha) DO NOTHING`.

`review.go`: upsert `pr_review` on `github_id`, resolving the reviewer to a user when the login is a known member. A review for a PR that is not yet stored is skipped rather than failed, since the PR event may simply not have arrived yet and reconciliation will pick it up.

`installation.go`: upsert `github_installation` on `installation` events, and mark `suspended_at` on suspend.

Wire `ticket worker` in `main.go` to build the client from config and run `worker.Run`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `cd api && go test ./internal/worker/... -v`
Expected: PASS, all nine tests.

- [ ] **Step 7: Commit**

```bash
git add api
git commit -m "Add worker that links PRs to issues as evidence without touching status"
```

---

### Task 6: Reconciliation, manual attach, and the evidence API

**Files:**
- Create: `api/internal/worker/reconcile.go`, `api/internal/worker/reconcile_test.go`, `api/internal/api/github.go`, `api/internal/api/github_test.go`
- Modify: `api/internal/api/server.go`, `api/internal/store/issue.go`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `(*Worker).Reconcile(ctx context.Context) error` - for each repo, re-fetch PRs updated since `synced_at`, upsert, re-link, then set `synced_at`.
  - `(*Store).ReposDueForSync(ctx context.Context, olderThan time.Duration) ([]Repo, error)`
  - `(*Store).EvidenceForIssue(ctx, workspaceID, issueID uuid.UUID) (store.Evidence, error)` with `Evidence{PullRequests []PullRequest; Reviews []Review; Commits []Commit}`
  - `(*Store).ManualLink(ctx, workspaceID, issueID, prID, actorID uuid.UUID) error`
  - `(*Store).Unlink(ctx, workspaceID, issueID, prID uuid.UUID) error`
- Routes: `GET /api/v1/w/{slug}/issues/{key}/evidence`, `POST /api/v1/w/{slug}/issues/{key}/prs`, `DELETE /api/v1/w/{slug}/issues/{key}/prs/{prID}`, `GET /api/v1/w/{slug}/pull-requests/unlinked`, `GET /api/v1/w/{slug}/repos`, `POST /api/v1/w/{slug}/repos`.

- [ ] **Step 1: Write the failing reconciliation test**

`api/internal/worker/reconcile_test.go`:

```go
package worker_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// stubWithPR serves an installation token and one open PR on branch
// sabari/eng-1-fix-auth, which is the PR whose webhook never arrived.
func stubWithPR(t *testing.T, number int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/99/access_tokens":
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
		case "/repos/acme/widgets/pulls":
			json.NewEncoder(w).Encode([]map[string]any{{
				"number": number, "title": "Fix auth", "state": "open", "draft": false,
				"body": "", "html_url": "https://github.com/acme/widgets/pull/77",
				"created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
				"user": map[string]any{"login": "sabari"},
				"head": map[string]any{"ref": "sabari/eng-1-fix-auth"},
			}})
		default:
			json.NewEncoder(w).Encode([]any{})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReconcileRecoversAMissedWebhook(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	w := testutil.NewWorker(t, f, stubWithPR(t, 77))
	require.NoError(t, w.Reconcile(t.Context()))

	var linked int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM pr_link WHERE issue_id = $1`, issue.ID).Scan(&linked))
	require.Equal(t, 1, linked,
		"reconciliation is what makes a missed webhook survivable")

	var syncedAt *time.Time
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT synced_at FROM repo WHERE github_id = 555`).Scan(&syncedAt))
	require.NotNil(t, syncedAt)
}

func TestReconcileIsIdempotent(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	wk := testutil.NewWorker(t, f, stubWithPR(t, 77))
	require.NoError(t, wk.Reconcile(t.Context()))
	require.NoError(t, wk.Reconcile(t.Context()))

	var prs, links, acts int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pull_request`).Scan(&prs))
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pr_link`).Scan(&links))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = 'attached_pr'`).Scan(&acts))
	require.Equal(t, 1, prs)
	require.Equal(t, 1, links)
	require.Equal(t, 1, acts)
}

func TestRateLimitLeavesSyncedAtUntouched(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Fix auth")
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			json.NewEncoder(w).Encode(map[string]any{
				"token":      "stub-installation-token",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
			return
		}
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset",
			strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	wk := testutil.NewWorker(t, f, srv)
	_ = wk.Reconcile(t.Context()) // the error is expected and not the assertion

	var syncedAt *time.Time
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT synced_at FROM repo WHERE github_id = 555`).Scan(&syncedAt))
	require.Nil(t, syncedAt,
		"stamping synced_at after a failed fetch would silently skip the gap")
}
```

Add `"strconv"` to the imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/worker/ -run Reconcile`
Expected: FAIL - undefined `Reconcile`.

- [ ] **Step 3: Implement reconciliation**

`api/internal/worker/reconcile.go` iterates repos, calls `ListPullRequests` with `since = synced_at` (or 90 days ago on first sync, which doubles as the backfill), reuses the same upsert-and-link path the webhook handler uses, and stamps `synced_at` only after the repo finishes successfully. On `ErrRateLimited`, stop early and leave `synced_at` untouched so the next run resumes rather than skipping the gap.

Add to `Run`: a ticker calling `Reconcile` hourly, alongside the job loop.

- [ ] **Step 4: Write the failing evidence API test**

`api/internal/api/github_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestEvidenceEndpointReturnsAttachedPRs(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "merged")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var ev store.Evidence
	f.DecodeInto(rec, &ev)
	require.Len(t, ev.PullRequests, 1)
	require.Equal(t, 42, ev.PullRequests[0].Number)
}

func TestManualAttachRecordsActivityAndIsIdempotent(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "open")

	body := map[string]any{"pull_request_id": pr.ID.String()}
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs", body).Code)
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs", body).Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbAttachedPR, issue.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestManualAttachDoesNotChangeStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "merged")

	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs",
			map[string]any{"pull_request_id": pr.ID.String()}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Equal(t, "backlog", got.Status)
}

func TestUnlinkRemovesTheEvidenceLink(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	pr := testutil.InsertPullRequest(t, f, 42, "Fix auth", "open")
	require.NoError(t, f.Store.ManualLink(t.Context(), f.WorkspaceID, issue.ID, pr.ID, f.User.ID))

	require.Equal(t, http.StatusNoContent,
		f.Do(http.MethodDelete,
			"/api/v1/w/lab/issues/"+issue.Key+"/prs/"+pr.ID.String(), nil).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/evidence", nil)
	var ev store.Evidence
	f.DecodeInto(rec, &ev)
	require.Empty(t, ev.PullRequests)
}

func TestUnlinkedListShowsUnmatchedPRs(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.InsertPullRequest(t, f, 42, "Stray PR", "open")

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/pull-requests/unlinked", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "Stray PR")
}

func TestPullRequestOfAnotherWorkspaceCannotBeAttached(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Fix auth"})
	foreign := testutil.InsertForeignPullRequest(t, f, 99, "Foreign")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/prs",
		map[string]any{"pull_request_id": foreign.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
```

Add `testutil.InsertPullRequest(t, f, number int, title, state string) store.PullRequest` and `testutil.InsertForeignPullRequest(t, f, number int, title string) uuid.UUID` to the fixtures. Both insert the installation and repo rows they need.

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run 'Evidence|Attach|Unlink|Foreign'`
Expected: FAIL - routes not found.

- [ ] **Step 6: Implement the evidence API**

`api/internal/api/github.go`. `ManualLink` must verify the PR belongs to the caller's workspace and return `store.ErrForeignReference` otherwise, which the handler maps to 400. Attaching an already-attached PR answers 201 without a second activity row.

Add repo management: `GET /repos` lists linked repos, `POST /repos` links one by `github_id`, `owner`, `name`, and `installation_id`, restricted to `admin`.

- [ ] **Step 7: Run the whole suite and verify it passes**

Run: `cd api && go build ./... && go vet ./... && go test ./...`
Expected: PASS for every package.

- [ ] **Step 8: Commit**

```bash
git add api
git commit -m "Add reconciliation, manual PR attach, and the issue evidence API"
```

---

## Self-Review

**Spec coverage (section 5):**

| Requirement | Task |
|---|---|
| Branch-name linking | 4, 5 |
| PR title/body linking with closing keywords | 4, 5 |
| Manual attach | 6 |
| Unlinked PRs stay visible | 5, 6 |
| Evidence cards (state, author, diff size, merge date) | 1 schema, 6 API |
| Attaching never changes status | 5 (asserted), 6 (asserted) |
| Merge prompts rather than transitions | the prompt is a UI concern; the API guarantees no transition, and plan 3 renders the prompt |
| Commits mirrored | 5 |
| Reviews mirrored | 5 |
| Webhook subscriptions | 2, 5 |
| HMAC verification, raw storage, dedup by delivery ID | 2 |
| Worker does the real work, handler returns fast | 2, 5 |
| Hourly and nightly reconciliation | 6 |
| ETags, rate-limit backoff | 3 |
| Repo onboarding with 90-day backfill | 6 |

**Placeholder scan:** the only content not written out in full is the fixture JSON in Task 5 step 1, which must be copied from GitHub's real documented payloads rather than invented. Task 5 step 1 states the exact field values the tests depend on, so the fixtures are fully specified even though the surrounding payload is not transcribed.

**Credential check:** no key, token, or secret appears in any file this plan creates. The test RSA key is generated in memory per test run, and the webhook test value is a non-credential string used only to compute an HMAC inside the same process.

**Type consistency:** `store.PullRequest` is the single PR type across store, worker, and API. `linker.Match.Source` uses the same `branch`/`body`/`manual` vocabulary as the `pr_link_source` enum. `Worker.ProcessOnce` is the tested entrypoint and `Worker.Run` only loops over it, so no test depends on timing.
