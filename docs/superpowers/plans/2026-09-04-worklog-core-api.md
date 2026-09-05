# Work-Log Ticketing System - Core API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go backend for the work-log ticketing system: GitHub OAuth sign-in, the sprint/milestone/issue hierarchy, comments as the progress log, and the activity stream that feeds every dashboard.

**Architecture:** A single Go module exposing a REST API over Postgres. One binary with subcommands (`serve`, `worker`, `migrate`). Handlers are thin; all SQL lives in `internal/store`; every mutation writes its `activity` row inside the same transaction as the change itself, so the feed can never disagree with the data. No ORM: hand-written SQL with `pgx/v5`.

**Tech Stack:** Go 1.26, Postgres 18, `pgx/v5`, stdlib `net/http` routing (Go 1.22+ method+wildcard patterns), `golang.org/x/oauth2`, `testcontainers-go` for integration tests, `testify` for assertions.

**Spec:** `docs/superpowers/specs/2026-09-04-worklog-ticketing-design.md`

**Scope:** This is plan 1 of 3. Plan 2 covers GitHub integration (webhooks, PR linking, reconciliation). Plan 3 covers the React SPA, reports, and deployment. This plan ends with a fully tested API that a frontend can be built against.

## Global Constraints

- Go module path: `github.com/NarayanaSabari/velvet-otter-lab/api`. Go 1.26.
- Every table below `workspace` carries `workspace_id`. Every store method takes `workspaceID uuid.UUID` and filters on it. No exceptions.
- Issue status enum is fixed: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`. Never user-configurable.
- Sub-issues and comment replies are one level deep only, enforced by database triggers, not by application code alone.
- No estimates, no story points, no time tracking anywhere.
- Every mutating store method that changes user-visible state records an `activity` row in the same transaction.
- Integration tests run against real Postgres via testcontainers. Never mock the database.
- All API routes live under `/api/v1`. All list endpoints are cursor-paginated.
- Secrets come from the environment only. Never commit a `.env`.
- Commit after every task. Never add tool attribution or `Co-Authored-By` trailers to commit messages.

---

### Task 1: Repository scaffold, configuration, migrations, and the test harness

**Files:**
- Create: `api/go.mod`, `api/cmd/ticket/main.go`, `api/internal/config/config.go`, `api/internal/db/db.go`, `api/internal/db/migrate.go`, `api/internal/db/migrations/0001_init.sql`, `api/internal/testutil/postgres.go`, `api/internal/db/migrate_test.go`
- Create: `.gitignore`, `api/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.Load() (*config.Config, error)` with fields `DatabaseURL, Port, GitHubClientID, GitHubClientSecret, BaseURL string`.
  - `db.Connect(ctx context.Context, url string) (*pgxpool.Pool, error)`
  - `db.Migrate(ctx context.Context, pool *pgxpool.Pool) error`
  - `testutil.NewPostgres(t *testing.T) *pgxpool.Pool` - starts a container, migrates, returns a pool, registers cleanup.

- [ ] **Step 1: Initialise the module and dependencies**

```bash
cd /Users/sabari/Developer/narayana/velvet-otter-lab
mkdir -p api/cmd/ticket api/internal/{config,db/migrations,testutil}
cd api
go mod init github.com/NarayanaSabari/velvet-otter-lab/api
go get github.com/jackc/pgx/v5@latest
go get github.com/google/uuid@latest
go get github.com/stretchr/testify@latest
go get github.com/testcontainers/testcontainers-go@latest
go get github.com/testcontainers/testcontainers-go/modules/postgres@latest
```

- [ ] **Step 2: Write `.gitignore` at the repo root**

```gitignore
.env
*.env
!*.env.example
/api/bin/
/web/node_modules/
/web/dist/
.DS_Store
```

- [ ] **Step 3: Write the config loader**

`api/internal/config/config.go`:

```go
package config

import (
	"fmt"
	"os"
)

type Config struct {
	DatabaseURL        string
	Port               string
	GitHubClientID     string
	GitHubClientSecret string
	BaseURL            string
}

func Load() (*Config, error) {
	c := &Config{
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		Port:               envOr("PORT", "8080"),
		GitHubClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		BaseURL:            envOr("BASE_URL", "http://localhost:8080"),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	return c, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

`api/.env.example`:

```
DATABASE_URL=postgres://ticket:ticket@localhost:5432/ticket?sslmode=disable
PORT=8080
BASE_URL=http://localhost:8080
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

- [ ] **Step 4: Write the full core schema**

`api/internal/db/migrations/0001_init.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_user (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id   bigint NOT NULL UNIQUE,
    github_login text NOT NULL,
    name        text NOT NULL DEFAULT '',
    avatar_url  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_login_idx ON app_user (lower(github_login));

CREATE TABLE workspace (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    slug          text NOT NULL UNIQUE,
    issue_prefix  text NOT NULL DEFAULT 'ENG',
    issue_counter bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE membership_role AS ENUM ('admin', 'member', 'viewer');

CREATE TABLE membership (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
    invited_login text NOT NULL,
    role          membership_role NOT NULL DEFAULT 'member',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, invited_login)
);
CREATE UNIQUE INDEX membership_user_idx
    ON membership (workspace_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE session (
    id         text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX session_user_idx ON session (user_id);

CREATE TYPE sprint_state AS ENUM ('upcoming', 'active', 'completed');

CREATE TABLE sprint (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         text NOT NULL,
    starts_on    date NOT NULL,
    ends_on      date NOT NULL,
    state        sprint_state NOT NULL DEFAULT 'upcoming',
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT sprint_dates_ordered CHECK (ends_on >= starts_on)
);
CREATE INDEX sprint_workspace_idx ON sprint (workspace_id, starts_on DESC);
CREATE UNIQUE INDEX sprint_single_active_idx
    ON sprint (workspace_id) WHERE state = 'active';

CREATE TYPE milestone_status AS ENUM ('planned', 'in_progress', 'completed', 'cancelled');

CREATE TABLE milestone (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    sprint_id    uuid NOT NULL REFERENCES sprint(id) ON DELETE CASCADE,
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    owner_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    target_date  date,
    status       milestone_status NOT NULL DEFAULT 'planned',
    position     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestone_sprint_idx ON milestone (workspace_id, sprint_id, position);

CREATE TYPE issue_status AS ENUM
    ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled');

CREATE TABLE issue (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    key          text NOT NULL,
    number       bigint NOT NULL,
    title        text NOT NULL,
    description  text NOT NULL DEFAULT '',
    status       issue_status NOT NULL DEFAULT 'backlog',
    priority     smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    assignee_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
    milestone_id uuid REFERENCES milestone(id) ON DELETE SET NULL,
    parent_id    uuid REFERENCES issue(id) ON DELETE SET NULL,
    position     text NOT NULL,
    created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, key)
);
CREATE INDEX issue_milestone_idx ON issue (workspace_id, milestone_id, position);
CREATE INDEX issue_assignee_idx ON issue (workspace_id, assignee_id, status);
CREATE INDEX issue_parent_idx ON issue (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX issue_status_updated_idx ON issue (workspace_id, status, updated_at DESC);

-- Sub-issues are one level deep. Enforced here so no code path can violate it.
CREATE FUNCTION issue_depth_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        IF NEW.parent_id = NEW.id THEN
            RAISE EXCEPTION 'issue cannot be its own parent';
        END IF;
        IF EXISTS (SELECT 1 FROM issue WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
            RAISE EXCEPTION 'sub-issues may not be nested more than one level';
        END IF;
        IF EXISTS (SELECT 1 FROM issue WHERE parent_id = NEW.id) THEN
            RAISE EXCEPTION 'an issue with children cannot become a sub-issue';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_depth_guard_trigger
    BEFORE INSERT OR UPDATE OF parent_id ON issue
    FOR EACH ROW EXECUTE FUNCTION issue_depth_guard();

CREATE TABLE label (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         text NOT NULL,
    color        text NOT NULL DEFAULT '#111111',
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

CREATE TABLE issue_label (
    issue_id uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    label_id uuid NOT NULL REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_label_label_idx ON issue_label (label_id);

CREATE TYPE comment_target AS ENUM ('issue', 'milestone');

CREATE TABLE comment (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    target_type  comment_target NOT NULL,
    target_id    uuid NOT NULL,
    parent_id    uuid REFERENCES comment(id) ON DELETE CASCADE,
    author_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    body         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    edited_at    timestamptz,
    deleted_at   timestamptz
);
CREATE INDEX comment_target_idx
    ON comment (workspace_id, target_type, target_id, created_at);

-- Comment threading is one level deep, same reasoning as sub-issues.
CREATE FUNCTION comment_depth_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
        RAISE EXCEPTION 'comment replies may not be nested more than one level';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comment_depth_guard_trigger
    BEFORE INSERT OR UPDATE OF parent_id ON comment
    FOR EACH ROW EXECUTE FUNCTION comment_depth_guard();

CREATE TABLE comment_mention (
    comment_id uuid NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    read_at    timestamptz,
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mention_unread_idx
    ON comment_mention (user_id) WHERE read_at IS NULL;

CREATE TABLE activity (
    id           bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    verb         text NOT NULL,
    target_type  text NOT NULL,
    target_id    uuid NOT NULL,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_workspace_idx ON activity (workspace_id, id DESC);
CREATE INDEX activity_actor_idx ON activity (workspace_id, actor_id, id DESC);
CREATE INDEX activity_target_idx ON activity (workspace_id, target_type, target_id, id DESC);
```

- [ ] **Step 5: Write the migration runner and pool**

`api/internal/db/db.go`:

```go
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}
```

`api/internal/db/migrate.go`:

```go
package db

import (
	"context"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate applies every unapplied migration in filename order. It takes a
// session-level advisory lock so that concurrently starting containers cannot
// apply the same migration twice.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(4242)`); err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	defer conn.Exec(ctx, `SELECT pg_advisory_unlock(4242)`)

	_, err = conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migration (
			name       text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`)
	if err != nil {
		return fmt.Errorf("create schema_migration: %w", err)
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		var exists bool
		err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migration WHERE name = $1)`, name).Scan(&exists)
		if err != nil {
			return fmt.Errorf("check %s: %w", name, err)
		}
		if exists {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migration (name) VALUES ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("record %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
	}
	return nil
}
```

- [ ] **Step 6: Write the test harness**

`api/internal/testutil/postgres.go`:

```go
package testutil

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
)

// NewPostgres starts a throwaway Postgres, applies all migrations, and returns
// a live pool. The container is torn down when the test finishes.
func NewPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	container, err := tcpostgres.Run(ctx, "postgres:18-alpine",
		tcpostgres.WithDatabase("ticket"),
		tcpostgres.WithUsername("ticket"),
		tcpostgres.WithPassword("ticket"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(container) })

	url, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	pool, err := db.Connect(ctx, url)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	require.NoError(t, db.Migrate(ctx, pool))
	return pool
}
```

- [ ] **Step 7: Write the failing migration test**

`api/internal/db/migrate_test.go`:

```go
package db_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestMigrateIsIdempotent(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()

	// Running again must be a no-op rather than an error.
	require.NoError(t, db.Migrate(ctx, pool))

	var tables int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public'`).Scan(&tables)
	require.NoError(t, err)
	require.GreaterOrEqual(t, tables, 12)
}

func TestSubIssueNestingIsRejected(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Test', 'test') RETURNING id`).Scan(&wsID))

	newIssue := func(key string, parent *string) (string, error) {
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, key, number, title, position, parent_id)
			VALUES ($1, $2, $3, $4, 'V', $5) RETURNING id`,
			wsID, key, len(key), "t "+key, parent).Scan(&id)
		return id, err
	}

	root, err := newIssue("ENG-1", nil)
	require.NoError(t, err)
	child, err := newIssue("ENG-2", &root)
	require.NoError(t, err)

	_, err = newIssue("ENG-3", &child)
	require.Error(t, err, "a grandchild must be rejected by the depth guard")
}
```

- [ ] **Step 8: Run the tests and verify they fail**

Run: `cd api && go test ./internal/db/...`
Expected: compile failure or test failure, because nothing has been wired yet. Fix any compile errors until the tests run and pass.

- [ ] **Step 9: Write the binary entrypoint**

`api/cmd/ticket/main.go`:

```go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ticket <serve|worker|migrate>")
	}
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	switch args[0] {
	case "migrate":
		return db.Migrate(ctx, pool)
	case "serve":
		return fmt.Errorf("serve is implemented in task 2")
	case "worker":
		return fmt.Errorf("worker is implemented in plan 2")
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
```

- [ ] **Step 10: Run the tests and verify they pass**

Run: `cd api && go build ./... && go test ./internal/db/...`
Expected: PASS for both tests.

- [ ] **Step 11: Commit**

```bash
git add api .gitignore
git commit -m "Add Go API scaffold, core schema, and Postgres test harness"
```

---

### Task 2: HTTP server, middleware, and the error model

**Files:**
- Create: `api/internal/api/server.go`, `api/internal/api/respond.go`, `api/internal/api/middleware.go`, `api/internal/api/server_test.go`
- Modify: `api/cmd/ticket/main.go`

**Interfaces:**
- Consumes: `db.Connect`, `config.Config`.
- Produces:
  - `api.NewServer(pool *pgxpool.Pool, cfg *config.Config) *api.Server`
  - `(*Server).Handler() http.Handler`
  - `api.WriteJSON(w http.ResponseWriter, status int, v any)`
  - `api.WriteError(w http.ResponseWriter, status int, code, message string)`
  - `api.ErrorResponse{Error struct{ Code, Message string }}` as the single error shape for every endpoint.

- [ ] **Step 1: Write the failing test**

`api/internal/api/server_test.go`:

```go
package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	pool := testutil.NewPostgres(t)
	cfg := &config.Config{
		BaseURL: "http://localhost:8080",
	}
	return api.NewServer(pool, cfg).Handler()
}

func TestHealthReportsOK(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "ok", body["status"])
}

func TestUnknownRouteReturnsStructuredError(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil))

	require.Equal(t, http.StatusNotFound, rec.Code)
	var body api.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "not_found", body.Error.Code)
}

func TestPanicBecomesInternalError(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/panic-test", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	var body api.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "internal", body.Error.Code)
	require.NotContains(t, rec.Body.String(), "deliberate panic",
		"internal detail must never reach the client")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/...`
Expected: FAIL - package `api` does not exist.

- [ ] **Step 3: Write the JSON helpers**

`api/internal/api/respond.go`:

```go
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
)

type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "err", err)
	}
}

func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, ErrorResponse{Error: ErrorBody{Code: code, Message: message}})
}

// DecodeJSON reads a request body into dst, rejecting unknown fields so that a
// misspelled client field fails loudly instead of being silently ignored.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var se *json.SyntaxError
		msg := "request body is not valid JSON"
		if errors.As(err, &se) {
			msg = fmt.Sprintf("malformed JSON at byte %d", se.Offset)
		} else if err != io.EOF {
			msg = err.Error()
		}
		WriteError(w, http.StatusBadRequest, "invalid_request", msg)
		return false
	}
	return true
}
```

- [ ] **Step 4: Write the middleware**

`api/internal/api/middleware.go`:

```go
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type ctxKey string

const requestIDKey ctxKey = "request_id"

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"ms", time.Since(start).Milliseconds(),
			"request_id", r.Context().Value(requestIDKey))
	})
}

// Recover turns a panic into a 500 without leaking the panic value, which may
// contain internal detail or user data.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				slog.Error("panic", "value", v, "path", r.URL.Path,
					"request_id", r.Context().Value(requestIDKey))
				WriteError(w, http.StatusInternalServerError, "internal",
					"an unexpected error occurred")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 5: Write the server**

`api/internal/api/server.go`:

```go
package api

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
)

type Server struct {
	pool *pgxpool.Pool
	cfg  *config.Config
}

func NewServer(pool *pgxpool.Pool, cfg *config.Config) *Server {
	return &Server{pool: pool, cfg: cfg}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if err := s.pool.Ping(r.Context()); err != nil {
			WriteError(w, http.StatusServiceUnavailable, "unavailable", "database unreachable")
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Exercised only by TestPanicBecomesInternalError; harmless in production
	// and worth keeping so the recovery path stays covered.
	mux.HandleFunc("GET /api/v1/panic-test", func(http.ResponseWriter, *http.Request) {
		panic("deliberate panic")
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	return RequestID(Logging(Recover(mux)))
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/...`
Expected: PASS, all three tests.

- [ ] **Step 7: Wire `serve` into the binary**

Replace the `case "serve":` line in `api/cmd/ticket/main.go` with:

```go
	case "serve":
		srv := &http.Server{
			Addr:              ":" + cfg.Port,
			Handler:           api.NewServer(pool, cfg).Handler(),
			ReadHeaderTimeout: 10 * time.Second,
		}
		slog.Info("listening", "addr", srv.Addr)
		return srv.ListenAndServe()
```

Add imports `log/slog`, `net/http`, `time`, and the `internal/api` package.

- [ ] **Step 8: Verify the build and commit**

```bash
cd api && go build ./... && go vet ./...
git add api
git commit -m "Add HTTP server, middleware, and JSON error model"
```

---

### Task 3: GitHub OAuth sign-in, sessions, and the membership gate

**Files:**
- Create: `api/internal/auth/session.go`, `api/internal/auth/github.go`, `api/internal/store/store.go`, `api/internal/store/user.go`, `api/internal/api/auth.go`, `api/internal/store/user_test.go`, `api/internal/api/auth_test.go`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Consumes: `api.WriteJSON`, `api.WriteError`, `db` pool.
- Produces:
  - `store.New(pool *pgxpool.Pool) *store.Store`
  - `(*Store).UpsertUserByGitHub(ctx, gh store.GitHubIdentity) (store.User, error)` where `GitHubIdentity{ID int64; Login, Name, AvatarURL string}`
  - `(*Store).BindMembership(ctx, userID uuid.UUID, login string) (int, error)` - claims any invite rows matching the login, returns the number bound.
  - `(*Store).MembershipsForUser(ctx, userID uuid.UUID) ([]store.Membership, error)`
  - `(*Store).CreateSession(ctx, userID uuid.UUID, ttl time.Duration) (token string, err error)`
  - `(*Store).UserBySessionToken(ctx, token string) (store.User, error)`
  - `(*Store).DeleteSession(ctx, token string) error`
  - `auth.HashToken(token string) string` - sha256 hex; only the hash is stored.
  - `api.CurrentUser(ctx) (store.User, bool)` and `api.CurrentWorkspace(ctx) (store.Membership, bool)`
  - `(*Server).RequireAuth(next http.Handler) http.Handler` and `(*Server).RequireWorkspace(next http.Handler) http.Handler`
  - `store.ErrNotFound` - the sentinel every store returns for a missing row.

- [ ] **Step 1: Write the failing store test**

`api/internal/store/user_test.go`:

```go
package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestUpsertUserIsIdempotent(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	u1, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 42, Login: "sabari", Name: "Sabari", AvatarURL: "https://x/a.png"})
	require.NoError(t, err)

	u2, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 42, Login: "sabari-renamed", Name: "Sabari K", AvatarURL: "https://x/b.png"})
	require.NoError(t, err)

	require.Equal(t, u1.ID, u2.ID, "the same GitHub id must map to one user")
	require.Equal(t, "sabari-renamed", u2.GitHubLogin, "a renamed login must be picked up")
}

func TestBindMembershipClaimsInviteCaseInsensitively(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	_, err := pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, invited_login, role) VALUES ($1, 'Sabari', 'admin')`, wsID)
	require.NoError(t, err)

	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 7, Login: "sabari"})
	require.NoError(t, err)

	bound, err := st.BindMembership(ctx, u.ID, u.GitHubLogin)
	require.NoError(t, err)
	require.Equal(t, 1, bound)

	ms, err := st.MembershipsForUser(ctx, u.ID)
	require.NoError(t, err)
	require.Len(t, ms, 1)
	require.Equal(t, "admin", ms[0].Role)
}

func TestSessionRoundTripAndExpiry(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 9, Login: "dev"})
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, u.ID, time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := st.UserBySessionToken(ctx, token)
	require.NoError(t, err)
	require.Equal(t, u.ID, got.ID)

	expired, err := st.CreateSession(ctx, u.ID, -time.Minute)
	require.NoError(t, err)
	_, err = st.UserBySessionToken(ctx, expired)
	require.ErrorIs(t, err, store.ErrNotFound, "an expired session must not authenticate")

	require.NoError(t, st.DeleteSession(ctx, token))
	_, err = st.UserBySessionToken(ctx, token)
	require.ErrorIs(t, err, store.ErrNotFound)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/store/...`
Expected: FAIL - package `store` does not exist.

- [ ] **Step 3: Write the store base**

`api/internal/store/store.go`:

```go
package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned for a missing row, so callers never have to know
// that pgx.ErrNoRows exists.
var ErrNotFound = errors.New("not found")

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// InTx runs fn inside a transaction, rolling back on error or panic. Every
// mutation that also records activity must go through this.
func (s *Store) InTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
```

- [ ] **Step 4: Write the user, membership, and session store**

`api/internal/store/user.go`:

```go
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          uuid.UUID `json:"id"`
	GitHubID    int64     `json:"github_id"`
	GitHubLogin string    `json:"github_login"`
	Name        string    `json:"name"`
	AvatarURL   string    `json:"avatar_url"`
}

type GitHubIdentity struct {
	ID        int64
	Login     string
	Name      string
	AvatarURL string
}

type Membership struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Slug        string    `json:"workspace_slug"`
	Name        string    `json:"workspace_name"`
	Role        string    `json:"role"`
}

func (s *Store) UpsertUserByGitHub(ctx context.Context, gh GitHubIdentity) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO app_user (github_id, github_login, name, avatar_url)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (github_id) DO UPDATE
		SET github_login = EXCLUDED.github_login,
		    name         = EXCLUDED.name,
		    avatar_url   = EXCLUDED.avatar_url,
		    updated_at   = now()
		RETURNING id, github_id, github_login, name, avatar_url`,
		gh.ID, gh.Login, gh.Name, gh.AvatarURL).
		Scan(&u.ID, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

// BindMembership claims any invite issued to this GitHub login. Invites are
// written before the user has ever signed in, so this is what turns an invite
// into real access.
func (s *Store) BindMembership(ctx context.Context, userID uuid.UUID, login string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE membership SET user_id = $1
		WHERE lower(invited_login) = lower($2) AND user_id IS NULL`, userID, login)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (s *Store) MembershipsForUser(ctx context.Context, userID uuid.UUID) ([]Membership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 ORDER BY w.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Membership
	for rows.Next() {
		var m Membership
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MembershipForSlug(ctx context.Context, userID uuid.UUID, slug string) (Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 AND w.slug = $2`, userID, slug).
		Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	return m, mapErr(err)
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateSession returns the raw token, which is handed to the browser once and
// never stored: the database holds only its hash, so a database leak cannot be
// replayed as a login.
func (s *Store) CreateSession(ctx context.Context, userID uuid.UUID, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session (id, user_id, expires_at) VALUES ($1, $2, now() + $3::interval)`,
		HashToken(token), userID, ttl.String())
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *Store) UserBySessionToken(ctx context.Context, token string) (User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.name, u.avatar_url
		FROM session s JOIN app_user u ON u.id = s.user_id
		WHERE s.id = $1 AND s.expires_at > now()`, HashToken(token)).
		Scan(&u.ID, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM session WHERE id = $1`, HashToken(token))
	return err
}
```

- [ ] **Step 5: Run the store tests and verify they pass**

Run: `cd api && go test ./internal/store/...`
Expected: PASS, all three tests.

- [ ] **Step 6: Write the OAuth flow and auth middleware**

`api/internal/auth/github.go`:

```go
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func OAuthConfig(clientID, clientSecret, baseURL string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  baseURL + "/api/v1/auth/github/callback",
		Scopes:       []string{"read:user"},
		Endpoint:     github.Endpoint,
	}
}

// FetchIdentity asks GitHub who the freshly authorised token belongs to.
func FetchIdentity(ctx context.Context, cfg *oauth2.Config, tok *oauth2.Token) (store.GitHubIdentity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return store.GitHubIdentity{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := cfg.Client(ctx, tok).Do(req)
	if err != nil {
		return store.GitHubIdentity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return store.GitHubIdentity{}, fmt.Errorf("github /user returned %d", resp.StatusCode)
	}

	var payload struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return store.GitHubIdentity{}, err
	}
	return store.GitHubIdentity{
		ID: payload.ID, Login: payload.Login,
		Name: payload.Name, AvatarURL: payload.AvatarURL,
	}, nil
}
```

`api/internal/auth/session.go`:

```go
package auth

import (
	"net/http"
	"time"
)

const CookieName = "ticket_session"
const SessionTTL = 30 * 24 * time.Hour

func SetSessionCookie(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(SessionTTL),
	})
}

func ClearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
```

`api/internal/api/auth.go`:

```go
package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

const userKey ctxKey = "user"
const workspaceKey ctxKey = "workspace"
const oauthStateCookie = "ticket_oauth_state"

func CurrentUser(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

func CurrentWorkspace(ctx context.Context) (store.Membership, bool) {
	m, ok := ctx.Value(workspaceKey).(store.Membership)
	return m, ok
}

func (s *Server) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/auth/github/login", s.handleLogin)
	mux.HandleFunc("GET /api/v1/auth/github/callback", s.handleCallback)
	mux.Handle("POST /api/v1/auth/logout", s.RequireAuth(http.HandlerFunc(s.handleLogout)))
	mux.Handle("GET /api/v1/me", s.RequireAuth(http.HandlerFunc(s.handleMe)))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start sign-in")
		return
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/",
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteLaxMode,
		Expires: time.Now().Add(10 * time.Minute),
	})
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	http.Redirect(w, r, cfg.AuthCodeURL(state), http.StatusFound)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(oauthStateCookie)
	if err != nil || cookie.Value == "" || cookie.Value != r.URL.Query().Get("state") {
		WriteError(w, http.StatusBadRequest, "invalid_state", "sign-in state did not match")
		return
	}
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	tok, err := cfg.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "exchange_failed", "could not complete sign-in")
		return
	}
	identity, err := auth.FetchIdentity(r.Context(), cfg, tok)
	if err != nil {
		WriteError(w, http.StatusBadGateway, "github_unavailable", "could not reach GitHub")
		return
	}

	user, err := s.store.UpsertUserByGitHub(r.Context(), identity)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not record the account")
		return
	}
	if _, err := s.store.BindMembership(r.Context(), user.ID, user.GitHubLogin); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not bind membership")
		return
	}
	memberships, err := s.store.MembershipsForUser(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read membership")
		return
	}
	// An uninvited GitHub account gets no session at all: discovering the URL
	// must not be enough to obtain an account.
	if len(memberships) == 0 {
		http.Redirect(w, r, "/not-invited", http.StatusFound)
		return
	}

	token, err := s.store.CreateSession(r.Context(), user.ID, auth.SessionTTL)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create a session")
		return
	}
	auth.SetSessionCookie(w, token, s.secureCookies())
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		_ = s.store.DeleteSession(r.Context(), c.Value)
	}
	auth.ClearSessionCookie(w, s.secureCookies())
	WriteJSON(w, http.StatusOK, map[string]string{"status": "signed_out"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	memberships, err := s.store.MembershipsForUser(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read membership")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"user":        user,
		"memberships": memberships,
	})
}

func (s *Server) secureCookies() bool {
	return strings.HasPrefix(s.cfg.BaseURL, "https://")
}

func (s *Server) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(auth.CookieName)
		if err != nil || c.Value == "" {
			WriteError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		user, err := s.store.UserBySessionToken(r.Context(), c.Value)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				WriteError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
				return
			}
			WriteError(w, http.StatusInternalServerError, "internal", "could not read the session")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

// RequireWorkspace resolves {slug} into a membership and rejects anyone who is
// not a member. Every workspace-scoped route sits behind this.
func (s *Server) RequireWorkspace(next http.Handler) http.Handler {
	return s.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, _ := CurrentUser(r.Context())
		m, err := s.store.MembershipForSlug(r.Context(), user.ID, r.PathValue("slug"))
		if err != nil {
			WriteError(w, http.StatusNotFound, "not_found", "no such workspace")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workspaceKey, m)))
	}))
}

// RequireRole wraps a handler so that viewers cannot mutate.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(roles))
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			m, ok := CurrentWorkspace(r.Context())
			if !ok || !allowed[m.Role] {
				WriteError(w, http.StatusForbidden, "forbidden", "insufficient permission")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

- [ ] **Step 7: Add the store to the server**

In `api/internal/api/server.go`, add a `store *store.Store` field, set it in `NewServer` with `store.New(pool)`, and call `s.registerAuthRoutes(mux)` inside `Handler()`.

- [ ] **Step 8: Write the auth middleware test**

`api/internal/api/auth_test.go`:

```go
package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestMeRequiresASession(t *testing.T) {
	pool := testutil.NewPostgres(t)
	cfg := &config.Config{BaseURL: "http://localhost:8080"}
	h := api.NewServer(pool, cfg).Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestMeReturnsUserAndMemberships(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 1, Login: "sabari"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'sabari', 'admin')`, wsID, u.ID)
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, u.ID, time.Hour)
	require.NoError(t, err)

	cfg := &config.Config{BaseURL: "http://localhost:8080"}
	h := api.NewServer(pool, cfg).Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"role":"admin"`)
	require.Contains(t, rec.Body.String(), `"github_login":"sabari"`)
}
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `cd api && go test ./...`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add api
git commit -m "Add GitHub OAuth sign-in, sessions, and invite-gated membership"
```

---

### Task 4: Shared primitives - fractional indexing, issue keys, activity recording

**Files:**
- Create: `api/internal/fracdex/fracdex.go`, `api/internal/fracdex/fracdex_test.go`, `api/internal/store/activity.go`, `api/internal/store/activity_test.go`
- Modify: `api/internal/store/store.go`

**Interfaces:**
- Consumes: `store.Store`, `store.InTx`.
- Produces:
  - `fracdex.Between(a, b string) (string, error)` - a string strictly between `a` and `b`; `""` means unbounded on that side. `fracdex.ErrOutOfOrder` when `a >= b`.
  - `store.Verb` constants: `VerbCommented`, `VerbCreatedIssue`, `VerbChangedStatus`, `VerbAssigned`, `VerbAttachedPR`, `VerbCompletedMilestone`, `VerbClosedSprint`.
  - `store.RecordActivity(ctx context.Context, tx pgx.Tx, a store.ActivityInput) error` where `ActivityInput{WorkspaceID, ActorID uuid.UUID; Verb, TargetType string; TargetID uuid.UUID; Metadata map[string]any}`.
  - `(*Store).NextIssueKey(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (key string, number int64, err error)` - increments `workspace.issue_counter` under the row lock the `UPDATE` already takes.

- [ ] **Step 1: Write the failing fracdex test**

`api/internal/fracdex/fracdex_test.go`:

```go
package fracdex_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/fracdex"
)

func TestBetweenProducesOrderedKeys(t *testing.T) {
	cases := []struct{ a, b string }{
		{"", ""},
		{"V", ""},
		{"", "V"},
		{"V", "W"},
		{"V0", "V1"},
	}
	for _, c := range cases {
		got, err := fracdex.Between(c.a, c.b)
		require.NoError(t, err, "Between(%q, %q)", c.a, c.b)
		if c.a != "" {
			require.Greater(t, got, c.a, "Between(%q, %q) = %q", c.a, c.b, got)
		}
		if c.b != "" {
			require.Less(t, got, c.b, "Between(%q, %q) = %q", c.a, c.b, got)
		}
	}
}

func TestRepeatedInsertionBetweenTheSamePairStaysOrdered(t *testing.T) {
	lo, hi := "V", "W"
	prev := lo
	for i := 0; i < 50; i++ {
		mid, err := fracdex.Between(prev, hi)
		require.NoError(t, err)
		require.Greater(t, mid, prev)
		require.Less(t, mid, hi)
		prev = mid
	}
}

func TestBetweenRejectsReversedArguments(t *testing.T) {
	_, err := fracdex.Between("W", "V")
	require.ErrorIs(t, err, fracdex.ErrOutOfOrder)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/fracdex/...`
Expected: FAIL - package does not exist.

- [ ] **Step 3: Implement fracdex**

`api/internal/fracdex/fracdex.go`:

```go
// Package fracdex generates order keys that sit strictly between two existing
// keys, so reordering a list writes one row instead of renumbering a column.
package fracdex

import "errors"

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const base = len(digits)

// maxLen bounds the recursion depth. Reaching it means the inputs were not
// produced by this package, so failing loudly beats looping forever.
const maxLen = 64

var (
	ErrOutOfOrder = errors.New("fracdex: a must sort before b")
	ErrTooDeep    = errors.New("fracdex: no key fits between the given bounds")
)

func idx(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 36
	default:
		return -1
	}
}

// Between returns a key strictly between a and b in byte order. An empty a
// means "before everything" and an empty b means "after everything".
func Between(a, b string) (string, error) {
	if a != "" && b != "" && a >= b {
		return "", ErrOutOfOrder
	}
	for i := 0; i < len(a); i++ {
		if idx(a[i]) < 0 {
			return "", ErrOutOfOrder
		}
	}
	for i := 0; i < len(b); i++ {
		if idx(b[i]) < 0 {
			return "", ErrOutOfOrder
		}
	}

	out := make([]byte, 0, 8)
	// bFree records that the prefix built so far is already strictly less than
	// b, after which b no longer constrains the remaining digits.
	bFree := b == ""

	for i := 0; i < maxLen; i++ {
		da := 0
		if i < len(a) {
			da = idx(a[i])
		}
		db := base
		if !bFree {
			if i < len(b) {
				db = idx(b[i])
			} else {
				db = 0
			}
		}
		if da+1 < db {
			out = append(out, digits[(da+db)/2])
			return string(out), nil
		}
		out = append(out, digits[da])
		if !bFree && da < db {
			bFree = true
		}
	}
	return "", ErrTooDeep
}

// First returns the key for the first item in an empty list.
func First() string { return "V" }
```

- [ ] **Step 4: Run the fracdex tests and verify they pass**

Run: `cd api && go test ./internal/fracdex/... -v`
Expected: PASS, all three tests.

- [ ] **Step 5: Write the failing activity test**

`api/internal/store/activity_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestRecordActivityRollsBackWithItsTransaction(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))
	u, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 3, Login: "dev"})
	require.NoError(t, err)

	// A failing transaction must leave no activity behind, which is the whole
	// reason activity is written in the same transaction as the change.
	err = st.InTx(ctx, func(tx pgx.Tx) error {
		if err := store.RecordActivity(ctx, tx, store.ActivityInput{
			WorkspaceID: wsID, ActorID: u.ID, Verb: store.VerbCreatedIssue,
			TargetType: "issue", TargetID: uuid.New(),
		}); err != nil {
			return err
		}
		return context.Canceled
	})
	require.Error(t, err)

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM activity`).Scan(&count))
	require.Equal(t, 0, count)
}

func TestNextIssueKeyIncrementsPerWorkspace(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Lab', 'lab', 'ENG')
		 RETURNING id`).Scan(&wsID))

	var keys []string
	require.NoError(t, st.InTx(ctx, func(tx pgx.Tx) error {
		for i := 0; i < 3; i++ {
			key, _, err := st.NextIssueKey(ctx, tx, wsID)
			if err != nil {
				return err
			}
			keys = append(keys, key)
		}
		return nil
	}))
	require.Equal(t, []string{"ENG-1", "ENG-2", "ENG-3"}, keys)
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd api && go test ./internal/store/ -run 'Activity|IssueKey'`
Expected: FAIL - undefined `store.RecordActivity`.

- [ ] **Step 7: Implement the activity recorder and key allocator**

`api/internal/store/activity.go`:

```go
package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	VerbCommented          = "commented"
	VerbCreatedIssue       = "created_issue"
	VerbChangedStatus      = "changed_status"
	VerbAssigned           = "assigned"
	VerbAttachedPR         = "attached_pr"
	VerbCompletedMilestone = "completed_milestone"
	VerbClosedSprint       = "closed_sprint"
)

type ActivityInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Verb        string
	TargetType  string
	TargetID    uuid.UUID
	Metadata    map[string]any
}

type Activity struct {
	ID          int64          `json:"id"`
	WorkspaceID uuid.UUID      `json:"workspace_id"`
	Actor       *User          `json:"actor"`
	Verb        string         `json:"verb"`
	TargetType  string         `json:"target_type"`
	TargetID    uuid.UUID      `json:"target_id"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   string         `json:"created_at"`
}

// RecordActivity must be called with the same tx as the change it describes,
// so the feed can never disagree with the underlying data.
func RecordActivity(ctx context.Context, tx pgx.Tx, a ActivityInput) error {
	meta := a.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO activity (workspace_id, actor_id, verb, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		a.WorkspaceID, a.ActorID, a.Verb, a.TargetType, a.TargetID, meta)
	if err != nil {
		return fmt.Errorf("record activity %s: %w", a.Verb, err)
	}
	return nil
}

// NextIssueKey allocates the next per-workspace issue number. The UPDATE takes
// a row lock, so two concurrent creators serialise rather than collide.
func (s *Store) NextIssueKey(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (string, int64, error) {
	var prefix string
	var number int64
	err := tx.QueryRow(ctx, `
		UPDATE workspace SET issue_counter = issue_counter + 1
		WHERE id = $1
		RETURNING issue_prefix, issue_counter`, workspaceID).Scan(&prefix, &number)
	if err != nil {
		return "", 0, mapErr(err)
	}
	return fmt.Sprintf("%s-%d", prefix, number), number, nil
}
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `cd api && go test ./internal/store/... ./internal/fracdex/...`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add api
git commit -m "Add fractional indexing, issue key allocation, and activity recording"
```

---

### Task 5: Sprints

**Files:**
- Create: `api/internal/store/sprint.go`, `api/internal/store/sprint_test.go`, `api/internal/api/sprint.go`, `api/internal/api/sprint_test.go`, `api/internal/testutil/fixtures.go`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Consumes: `store.Store`, `store.RecordActivity`, `api.RequireWorkspace`, `api.RequireRole`.
- Produces:
  - `store.Sprint{ID uuid.UUID; WorkspaceID uuid.UUID; Name string; StartsOn, EndsOn string; State string; CreatedAt string; CompletedAt *string}` where dates are `YYYY-MM-DD`.
  - `(*Store).CreateSprint(ctx, in store.CreateSprintInput) (Sprint, error)` with `CreateSprintInput{WorkspaceID, ActorID uuid.UUID; Name, StartsOn, EndsOn string}`
  - `(*Store).ListSprints(ctx, workspaceID uuid.UUID) ([]Sprint, error)`
  - `(*Store).GetSprint(ctx, workspaceID, id uuid.UUID) (Sprint, error)`
  - `(*Store).ActivateSprint(ctx, workspaceID, id, actorID uuid.UUID) (Sprint, error)`
  - `(*Store).CloseSprint(ctx, workspaceID, id, actorID uuid.UUID) (Sprint, error)` - sets `completed`, moves unfinished issues to the next upcoming sprint's milestones is out of scope here (plan 3), records `closed_sprint` activity.
  - `testutil.Fixture` with fields `Pool`, `Store`, `WorkspaceID uuid.UUID`, `User store.User`, `Token string`, `Handler http.Handler`, and helper `testutil.NewFixture(t *testing.T) *Fixture` plus `(*Fixture).Do(method, path string, body any) *httptest.ResponseRecorder`.
- Routes: `GET/POST /api/v1/w/{slug}/sprints`, `GET /api/v1/w/{slug}/sprints/{id}`, `POST /api/v1/w/{slug}/sprints/{id}/activate`, `POST /api/v1/w/{slug}/sprints/{id}/close`.

- [ ] **Step 1: Write the shared HTTP fixture**

`api/internal/testutil/fixtures.go`:

```go
package testutil

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type Fixture struct {
	T           *testing.T
	Pool        *pgxpool.Pool
	Store       *store.Store
	Handler     http.Handler
	WorkspaceID uuid.UUID
	Slug        string
	User        store.User
	Token       string
}

// NewFixture gives a test a migrated database, one workspace, one signed-in
// admin, and a ready HTTP handler.
func NewFixture(t *testing.T) *Fixture {
	t.Helper()
	pool := NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Lab', 'lab', 'ENG')
		 RETURNING id`).Scan(&wsID))

	user, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 1001, Login: "sabari", Name: "Sabari"})
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'sabari', 'admin')`, wsID, user.ID)
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, user.ID, time.Hour)
	require.NoError(t, err)

	cfg := &config.Config{BaseURL: "http://localhost:8080"}

	return &Fixture{
		T: t, Pool: pool, Store: st,
		Handler:     api.NewServer(pool, cfg).Handler(),
		WorkspaceID: wsID, Slug: "lab", User: user, Token: token,
	}
}

// Do issues an authenticated request against the fixture's handler.
func (f *Fixture) Do(method, path string, body any) *httptest.ResponseRecorder {
	f.T.Helper()
	var buf bytes.Buffer
	if body != nil {
		require.NoError(f.T, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// DecodeInto unmarshals a recorder body, failing the test on bad JSON.
func (f *Fixture) DecodeInto(rec *httptest.ResponseRecorder, dst any) {
	f.T.Helper()
	require.NoError(f.T, json.Unmarshal(rec.Body.Bytes(), dst), "body: %s", rec.Body.String())
}
```

- [ ] **Step 2: Write the failing sprint API test**

`api/internal/api/sprint_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCreateAndListSprints(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September 2026", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var created store.Sprint
	f.DecodeInto(rec, &created)
	require.Equal(t, "upcoming", created.State)
	require.Equal(t, "2026-09-01", created.StartsOn)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Sprints []store.Sprint `json:"sprints"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Sprints, 1)
}

func TestSprintRejectsReversedDates(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "Bad", "starts_on": "2026-09-30", "ends_on": "2026-09-01"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid_request")
}

func TestOnlyOneSprintCanBeActive(t *testing.T) {
	f := testutil.NewFixture(t)

	mk := func(name, from, to string) store.Sprint {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
			"name": name, "starts_on": from, "ends_on": to})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var s store.Sprint
		f.DecodeInto(rec, &s)
		return s
	}
	sept := mk("September", "2026-09-01", "2026-09-30")
	oct := mk("October", "2026-10-01", "2026-10-31")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/activate", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Activating October must close September rather than fail, because a team
	// rolling into a new month should not have to remember a manual step.
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+oct.ID.String()+"/activate", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	var list struct {
		Sprints []store.Sprint `json:"sprints"`
	}
	f.DecodeInto(rec, &list)

	active := 0
	for _, s := range list.Sprints {
		if s.State == "active" {
			active++
		}
	}
	require.Equal(t, 1, active)
}

func TestClosingASprintRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	var s store.Sprint
	f.DecodeInto(rec, &s)

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/activate", nil).Code)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+s.ID.String()+"/close", nil).Code)

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1`, s.ID).Scan(&verb))
	require.Equal(t, store.VerbClosedSprint, verb)
}

func TestSprintsOfAnotherWorkspaceAreInvisible(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(),
		`INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
		 VALUES ($1, 'Secret', '2026-09-01', '2026-09-30')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), "Secret")

	rec = f.Do(http.MethodGet, "/api/v1/w/other/sprints", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Sprint`
Expected: FAIL - `store.Sprint` undefined.

- [ ] **Step 4: Implement the sprint store**

`api/internal/store/sprint.go`:

```go
package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Sprint struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Name        string    `json:"name"`
	StartsOn    string    `json:"starts_on"`
	EndsOn      string    `json:"ends_on"`
	State       string    `json:"state"`
	CreatedAt   string    `json:"created_at"`
	CompletedAt *string   `json:"completed_at"`
}

type CreateSprintInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Name        string
	StartsOn    string
	EndsOn      string
}

const sprintCols = `id, workspace_id, name,
	to_char(starts_on, 'YYYY-MM-DD'), to_char(ends_on, 'YYYY-MM-DD'),
	state::text, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
	to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')`

func scanSprint(row pgx.Row) (Sprint, error) {
	var s Sprint
	err := row.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.StartsOn, &s.EndsOn,
		&s.State, &s.CreatedAt, &s.CompletedAt)
	return s, mapErr(err)
}

func (s *Store) CreateSprint(ctx context.Context, in CreateSprintInput) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			INSERT INTO sprint (workspace_id, name, starts_on, ends_on)
			VALUES ($1, $2, $3::date, $4::date)
			RETURNING `+sprintCols,
			in.WorkspaceID, in.Name, in.StartsOn, in.EndsOn)
		var err error
		out, err = scanSprint(row)
		return err
	})
	return out, err
}

func (s *Store) ListSprints(ctx context.Context, workspaceID uuid.UUID) ([]Sprint, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+sprintCols+` FROM sprint WHERE workspace_id = $1 ORDER BY starts_on DESC`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Sprint{}
	for rows.Next() {
		sp, err := scanSprint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

func (s *Store) GetSprint(ctx context.Context, workspaceID, id uuid.UUID) (Sprint, error) {
	return scanSprint(s.pool.QueryRow(ctx,
		`SELECT `+sprintCols+` FROM sprint WHERE workspace_id = $1 AND id = $2`,
		workspaceID, id))
}

// ActivateSprint makes one sprint active, completing whichever sprint was
// active before. The schema allows only one active sprint per workspace, so
// this is done in a single transaction.
func (s *Store) ActivateSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND state = 'active' AND id <> $2`,
			workspaceID, id); err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'active', completed_at = NULL
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		out, err = scanSprint(row)
		return err
	})
	return out, err
}

func (s *Store) CloseSprint(ctx context.Context, workspaceID, id, actorID uuid.UUID) (Sprint, error) {
	var out Sprint
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			UPDATE sprint SET state = 'completed', completed_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+sprintCols, workspaceID, id)
		var err error
		if out, err = scanSprint(row); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbClosedSprint, TargetType: "sprint", TargetID: id,
			Metadata: map[string]any{"name": out.Name},
		})
	})
	return out, err
}
```

- [ ] **Step 5: Implement the sprint handlers**

`api/internal/api/sprint.go`:

```go
package api

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (s *Server) registerSprintRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/sprints",
		s.RequireWorkspace(http.HandlerFunc(s.handleListSprints)))
	mux.Handle("POST /api/v1/w/{slug}/sprints",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateSprint))))
	mux.Handle("GET /api/v1/w/{slug}/sprints/{id}",
		s.RequireWorkspace(http.HandlerFunc(s.handleGetSprint)))
	mux.Handle("POST /api/v1/w/{slug}/sprints/{id}/activate",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleActivateSprint))))
	mux.Handle("POST /api/v1/w/{slug}/sprints/{id}/close",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCloseSprint))))
}

func (s *Server) handleListSprints(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	sprints, err := s.store.ListSprints(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list sprints")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"sprints": sprints})
}

func (s *Server) handleCreateSprint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		StartsOn string `json:"starts_on"`
		EndsOn   string `json:"ends_on"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Name == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	if !dateRe.MatchString(body.StartsOn) || !dateRe.MatchString(body.EndsOn) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "dates must be YYYY-MM-DD")
		return
	}
	if body.EndsOn < body.StartsOn {
		WriteError(w, http.StatusBadRequest, "invalid_request", "ends_on must not precede starts_on")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sprint, err := s.store.CreateSprint(r.Context(), store.CreateSprintInput{
		WorkspaceID: ws.WorkspaceID, ActorID: user.ID,
		Name: body.Name, StartsOn: body.StartsOn, EndsOn: body.EndsOn,
	})
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create the sprint")
		return
	}
	WriteJSON(w, http.StatusCreated, sprint)
}

func (s *Server) handleGetSprint(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	sprint, err := s.store.GetSprint(r.Context(), ws.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, err, "sprint")
		return
	}
	WriteJSON(w, http.StatusOK, sprint)
}

func (s *Server) handleActivateSprint(w http.ResponseWriter, r *http.Request) {
	s.mutateSprint(w, r, s.store.ActivateSprint)
}

func (s *Server) handleCloseSprint(w http.ResponseWriter, r *http.Request) {
	s.mutateSprint(w, r, s.store.CloseSprint)
}

type sprintMutator func(ctx context.Context, workspaceID, id, actorID uuid.UUID) (store.Sprint, error)

func (s *Server) mutateSprint(w http.ResponseWriter, r *http.Request, fn sprintMutator) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	sprint, err := fn(r.Context(), ws.WorkspaceID, id, user.ID)
	if err != nil {
		writeStoreError(w, err, "sprint")
		return
	}
	WriteJSON(w, http.StatusOK, sprint)
}

// pathUUID parses a {name} path value, answering 400 rather than 500 on junk.
func pathUUID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", name+" must be a UUID")
		return uuid.Nil, false
	}
	return id, true
}

func writeStoreError(w http.ResponseWriter, err error, what string) {
	if errors.Is(err, store.ErrNotFound) {
		WriteError(w, http.StatusNotFound, "not_found", "no such "+what)
		return
	}
	WriteError(w, http.StatusInternalServerError, "internal", "could not read the "+what)
}
```

Add `"context"` to the import block. Register the routes by adding `s.registerSprintRoutes(mux)` in `Handler()`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Sprint -v`
Expected: PASS, all five tests.

- [ ] **Step 7: Commit**

```bash
git add api
git commit -m "Add sprints with single-active invariant and close activity"
```

---

### Task 6: Milestones

**Files:**
- Create: `api/internal/store/milestone.go`, `api/internal/api/milestone.go`, `api/internal/api/milestone_test.go`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Consumes: `fracdex.Between`, `fracdex.First`, `store.RecordActivity`, `testutil.NewFixture`.
- Produces:
  - `store.Milestone{ID, WorkspaceID, SprintID uuid.UUID; Name, Description string; OwnerID *uuid.UUID; TargetDate *string; Status, Position, CreatedAt, UpdatedAt string; IssueCounts map[string]int; LastComment *store.Comment}` - `IssueCounts` and `LastComment` are populated only by `ListMilestonesForSprint`.
  - `(*Store).CreateMilestone(ctx, in CreateMilestoneInput) (Milestone, error)` with `CreateMilestoneInput{WorkspaceID, SprintID, ActorID uuid.UUID; Name, Description string; OwnerID *uuid.UUID; TargetDate *string}`
  - `(*Store).ListMilestonesForSprint(ctx, workspaceID, sprintID uuid.UUID) ([]Milestone, error)`
  - `(*Store).GetMilestone(ctx, workspaceID, id uuid.UUID) (Milestone, error)`
  - `(*Store).UpdateMilestone(ctx, workspaceID, id, actorID uuid.UUID, patch MilestonePatch) (Milestone, error)` with `MilestonePatch{Name, Description, Status, TargetDate *string; OwnerID **uuid.UUID; AfterID, BeforeID *uuid.UUID}` - a nil field means "leave unchanged"; a double pointer distinguishes "set to null" from "leave unchanged".
- Routes: `GET /api/v1/w/{slug}/sprints/{sprintID}/milestones`, `POST /api/v1/w/{slug}/sprints/{sprintID}/milestones`, `GET/PATCH /api/v1/w/{slug}/milestones/{id}`.

- [ ] **Step 1: Write the failing test**

`api/internal/api/milestone_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func newSprint(t *testing.T, f *testutil.Fixture) store.Sprint {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "September", "starts_on": "2026-09-01", "ends_on": "2026-09-30"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var s store.Sprint
	f.DecodeInto(rec, &s)
	return s
}

func TestCreateMilestoneUnderSprint(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth", "description": "OAuth end to end"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var m store.Milestone
	f.DecodeInto(rec, &m)
	require.Equal(t, "Ship auth", m.Name)
	require.Equal(t, "planned", m.Status)
	require.NotEmpty(t, m.Position)
}

func TestMilestonesAreOrderedByPosition(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	for _, name := range []string{"First", "Second", "Third"} {
		rec := f.Do(http.MethodPost,
			"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
			map[string]any{"name": name})
		require.Equal(t, http.StatusCreated, rec.Code)
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Milestones []store.Milestone `json:"milestones"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Milestones, 3)
	require.Equal(t, "First", list.Milestones[0].Name)
	require.Less(t, list.Milestones[0].Position, list.Milestones[1].Position)
	require.Less(t, list.Milestones[1].Position, list.Milestones[2].Position)
}

func TestCompletingAMilestoneRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/milestones/"+m.ID.String(),
		map[string]any{"status": "completed"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1`, m.ID).Scan(&verb))
	require.Equal(t, store.VerbCompletedMilestone, verb)
}

func TestMilestoneRejectsUnknownStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/milestones/"+m.ID.String(),
		map[string]any{"status": "almost"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Milestone`
Expected: FAIL - `store.Milestone` undefined.

- [ ] **Step 3: Implement the milestone store**

`api/internal/store/milestone.go`: implement the interfaces listed above.

Key behaviours the implementation must have:

```go
// Position on create: append to the end of the sprint's list.
var last string
err := tx.QueryRow(ctx, `
    SELECT position FROM milestone
    WHERE workspace_id = $1 AND sprint_id = $2
    ORDER BY position DESC LIMIT 1`, in.WorkspaceID, in.SprintID).Scan(&last)
switch {
case errors.Is(err, pgx.ErrNoRows):
    position = fracdex.First()
case err != nil:
    return err
default:
    position, err = fracdex.Between(last, "")
    if err != nil {
        return err
    }
}
```

```go
// UpdateMilestone records completed_milestone activity only on the transition
// into 'completed', so re-saving a completed milestone does not spam the feed.
if patch.Status != nil && *patch.Status == "completed" && previousStatus != "completed" {
    if err := RecordActivity(ctx, tx, ActivityInput{
        WorkspaceID: workspaceID, ActorID: actorID,
        Verb: VerbCompletedMilestone, TargetType: "milestone", TargetID: id,
        Metadata: map[string]any{"name": updated.Name},
    }); err != nil {
        return err
    }
}
```

`ListMilestonesForSprint` returns issue counts and the latest comment in one round trip, because the sprint view needs both for every row:

```sql
SELECT m.id, m.workspace_id, m.sprint_id, m.name, m.description, m.owner_id,
       to_char(m.target_date, 'YYYY-MM-DD'), m.status::text, m.position,
       to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
       to_char(m.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
       COALESCE(counts.by_status, '{}'::jsonb),
       lc.id, lc.body, lc.author_id,
       to_char(lc.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
FROM milestone m
LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(status, n) AS by_status
    FROM (SELECT status::text AS status, count(*) AS n
          FROM issue WHERE milestone_id = m.id GROUP BY status) s
) counts ON true
LEFT JOIN LATERAL (
    SELECT c.id, c.body, c.author_id, c.created_at
    FROM comment c
    WHERE c.target_type = 'milestone' AND c.target_id = m.id AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC LIMIT 1
) lc ON true
WHERE m.workspace_id = $1 AND m.sprint_id = $2
ORDER BY m.position
```

- [ ] **Step 4: Implement the milestone handlers**

`api/internal/api/milestone.go`: register the four routes, validate that `status` is one of `planned`, `in_progress`, `completed`, `cancelled` (400 otherwise), validate `target_date` against `dateRe` when present, and require the `admin` or `member` role for `POST` and `PATCH`.

Verify the milestone's sprint belongs to the caller's workspace before inserting, so a valid UUID from another workspace cannot be used as a parent.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Milestone -v`
Expected: PASS, all four tests.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "Add milestones with ordering, status transitions, and rollup counts"
```

---

### Task 7: Issues

**Files:**
- Create: `api/internal/store/issue.go`, `api/internal/api/issue.go`, `api/internal/api/issue_test.go`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Consumes: `store.NextIssueKey`, `fracdex`, `store.RecordActivity`.
- Produces:
  - `store.Issue{ID, WorkspaceID uuid.UUID; Key string; Number int64; Title, Description, Status string; Priority int; AssigneeID, MilestoneID, ParentID *uuid.UUID; Position string; CreatedBy *uuid.UUID; CreatedAt, UpdatedAt string; Labels []Label; Children []Issue}`
  - `(*Store).CreateIssue(ctx, in CreateIssueInput) (Issue, error)` with `CreateIssueInput{WorkspaceID, ActorID uuid.UUID; Title, Description string; Status string; Priority int; AssigneeID, MilestoneID, ParentID *uuid.UUID}`
  - `(*Store).ListIssues(ctx, workspaceID uuid.UUID, f IssueFilter) ([]Issue, string, error)` returning the page and the next cursor; `IssueFilter{MilestoneID, SprintID, AssigneeID *uuid.UUID; Statuses []string; Cursor string; Limit int}`
  - `(*Store).GetIssueByKey(ctx, workspaceID uuid.UUID, key string) (Issue, error)`
  - `(*Store).UpdateIssue(ctx, workspaceID, id, actorID uuid.UUID, patch IssuePatch) (Issue, error)` with `IssuePatch{Title, Description, Status *string; Priority *int; AssigneeID, MilestoneID, ParentID **uuid.UUID; AfterID, BeforeID *uuid.UUID}`
  - `store.ValidIssueStatus(s string) bool`
- Routes: `GET/POST /api/v1/w/{slug}/issues`, `GET/PATCH /api/v1/w/{slug}/issues/{key}`.

- [ ] **Step 1: Write the failing test**

`api/internal/api/issue_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func createIssue(t *testing.T, f *testutil.Fixture, body map[string]any) store.Issue {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues", body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var i store.Issue
	f.DecodeInto(rec, &i)
	return i
}

func TestIssueKeysIncrementPerWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	first := createIssue(t, f, map[string]any{"title": "First"})
	second := createIssue(t, f, map[string]any{"title": "Second"})
	require.Equal(t, "ENG-1", first.Key)
	require.Equal(t, "ENG-2", second.Key)
	require.Equal(t, "backlog", first.Status, "an issue starts in the backlog")
}

func TestCreatingAnIssueRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1`, issue.ID).Scan(&verb))
	require.Equal(t, store.VerbCreatedIssue, verb)
}

func TestStatusChangeAndAssignmentEachRecordActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"status": "in_progress", "assignee_id": f.User.ID.String()})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rows, err := f.Pool.Query(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 ORDER BY id`, issue.ID)
	require.NoError(t, err)
	defer rows.Close()

	var verbs []string
	for rows.Next() {
		var v string
		require.NoError(t, rows.Scan(&v))
		verbs = append(verbs, v)
	}
	require.Equal(t,
		[]string{store.VerbCreatedIssue, store.VerbChangedStatus, store.VerbAssigned}, verbs)
}

func TestUnchangedPatchRecordsNoActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	// Re-sending the same status must not add a row: a feed full of no-ops is
	// a feed nobody reads.
	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"status": "backlog"})
	require.Equal(t, http.StatusOK, rec.Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE target_id = $1 AND verb = $2`,
		issue.ID, store.VerbChangedStatus).Scan(&count))
	require.Equal(t, 0, count)
}

func TestIssueRejectsUnknownStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues",
		map[string]any{"title": "Bad", "status": "shipping"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSubIssueNestingIsRejectedByTheAPI(t *testing.T) {
	f := testutil.NewFixture(t)
	parent := createIssue(t, f, map[string]any{"title": "Parent"})
	child := createIssue(t, f,
		map[string]any{"title": "Child", "parent_id": parent.ID.String()})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues",
		map[string]any{"title": "Grandchild", "parent_id": child.ID.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "one level")
}

func TestIssueListFiltersByStatusAndAssignee(t *testing.T) {
	f := testutil.NewFixture(t)
	createIssue(t, f, map[string]any{"title": "Untouched"})
	mine := createIssue(t, f, map[string]any{
		"title": "Mine", "assignee_id": f.User.ID.String(), "status": "in_progress"})

	rec := f.Do(http.MethodGet,
		"/api/v1/w/lab/issues?status=in_progress&assignee_id="+f.User.ID.String(), nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var list struct {
		Issues     []store.Issue `json:"issues"`
		NextCursor string        `json:"next_cursor"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Issues, 1)
	require.Equal(t, mine.Key, list.Issues[0].Key)
}

func TestIssueOfAnotherWorkspaceIsNotReachable(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO issue (workspace_id, key, number, title, position)
		VALUES ($1, 'ENG-1', 1, 'Secret', 'V')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/ENG-1", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Issue`
Expected: FAIL - `store.Issue` undefined.

- [ ] **Step 3: Implement the issue store**

`api/internal/store/issue.go`. Required behaviours:

```go
func ValidIssueStatus(s string) bool {
	switch s {
	case "backlog", "todo", "in_progress", "in_review", "done", "cancelled":
		return true
	}
	return false
}
```

Create, in one transaction: allocate the key with `NextIssueKey`, compute `position` by appending to the target milestone's list (or the unfiled list when `MilestoneID` is nil), insert, then `RecordActivity` with `VerbCreatedIssue` and metadata `{"key": key, "title": title}`.

Update must compare before and after and record one activity row per real change:

```go
if patch.Status != nil && *patch.Status != before.Status {
    if err := RecordActivity(ctx, tx, ActivityInput{
        WorkspaceID: workspaceID, ActorID: actorID,
        Verb: VerbChangedStatus, TargetType: "issue", TargetID: id,
        Metadata: map[string]any{
            "key": before.Key, "from": before.Status, "to": *patch.Status},
    }); err != nil {
        return err
    }
}
if patch.AssigneeID != nil && !sameUUIDPtr(before.AssigneeID, *patch.AssigneeID) {
    // VerbAssigned, metadata {"key":..., "assignee_id": ...}
}
```

The depth-guard trigger raises a Postgres error for illegal nesting. Translate it rather than surfacing a 500:

```go
var pgErr *pgconn.PgError
if errors.As(err, &pgErr) && strings.Contains(pgErr.Message, "one level") {
    return Issue{}, ErrInvalidNesting
}
```

Add `var ErrInvalidNesting = errors.New("sub-issues may be nested only one level")` to `store.go`.

`ListIssues` paginates on `(position, id)` with a cursor of `base64("position|id")`, filters by any combination of `milestone_id`, `sprint_id` (joining through `milestone`), `assignee_id`, and repeated `status` values, and defaults `Limit` to 50 with a cap of 200.

`GetIssueByKey` also loads labels and direct children.

- [ ] **Step 4: Implement the issue handlers**

`api/internal/api/issue.go`. Validate `status` with `store.ValidIssueStatus` and `priority` in 0-4, returning 400. Map `store.ErrInvalidNesting` to a 400 whose message contains "one level". Require `admin` or `member` for `POST` and `PATCH`.

Parse the optional `after_id` and `before_id` body fields for reordering and pass them through as `IssuePatch.AfterID` / `BeforeID`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Issue -v`
Expected: PASS, all eight tests.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "Add issues with keys, ordering, filters, and per-change activity"
```

---

### Task 8: Labels

**Files:**
- Create: `api/internal/store/label.go`, `api/internal/api/label.go`, `api/internal/api/label_test.go`
- Modify: `api/internal/api/server.go`, `api/internal/store/issue.go`

**Interfaces:**
- Consumes: `store.Store`, issue store.
- Produces:
  - `store.Label{ID, WorkspaceID uuid.UUID; Name, Color string}`
  - `(*Store).CreateLabel(ctx, workspaceID uuid.UUID, name, color string) (Label, error)`
  - `(*Store).ListLabels(ctx, workspaceID uuid.UUID) ([]Label, error)`
  - `(*Store).DeleteLabel(ctx, workspaceID, id uuid.UUID) error`
  - `(*Store).SetIssueLabels(ctx, workspaceID, issueID uuid.UUID, labelIDs []uuid.UUID) ([]Label, error)`
  - `store.ErrDuplicate` for a unique-violation, added to `store.go`.
- Routes: `GET/POST /api/v1/w/{slug}/labels`, `DELETE /api/v1/w/{slug}/labels/{id}`, `PUT /api/v1/w/{slug}/issues/{key}/labels`.

- [ ] **Step 1: Write the failing test**

`api/internal/api/label_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCreateAndListLabels(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels",
		map[string]any{"name": "bug", "color": "#b91c1c"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/labels", nil)
	var list struct {
		Labels []store.Label `json:"labels"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Labels, 1)
	require.Equal(t, "bug", list.Labels[0].Name)
}

func TestDuplicateLabelNameIsRejected(t *testing.T) {
	f := testutil.NewFixture(t)
	body := map[string]any{"name": "bug", "color": "#b91c1c"}
	require.Equal(t, http.StatusCreated, f.Do(http.MethodPost, "/api/v1/w/lab/labels", body).Code)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels", body)
	require.Equal(t, http.StatusConflict, rec.Code)
}

func TestSetIssueLabelsReplacesTheSet(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	mk := func(name string) store.Label {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/labels",
			map[string]any{"name": name, "color": "#111111"})
		require.Equal(t, http.StatusCreated, rec.Code)
		var l store.Label
		f.DecodeInto(rec, &l)
		return l
	}
	bug, chore := mk("bug"), mk("chore")

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{bug.ID.String(), chore.ID.String()}})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{chore.ID.String()}})
	require.Equal(t, http.StatusOK, rec.Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Len(t, got.Labels, 1)
	require.Equal(t, "chore", got.Labels[0].Name)
}

func TestLabelFromAnotherWorkspaceCannotBeAttached(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	var otherWS, foreignLabel string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO label (workspace_id, name) VALUES ($1, 'foreign') RETURNING id`,
		otherWS).Scan(&foreignLabel))

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/issues/"+issue.Key+"/labels",
		map[string]any{"label_ids": []string{foreignLabel}})
	require.Equal(t, http.StatusBadRequest, rec.Code,
		"a label from another workspace must be refused")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Label`
Expected: FAIL - `store.Label` undefined.

- [ ] **Step 3: Implement the label store**

`api/internal/store/label.go`. `SetIssueLabels` runs in one transaction: verify every supplied label belongs to `workspaceID` (returning `ErrForeignReference` if not), delete the existing rows for the issue, insert the new set, and return the resulting labels ordered by name.

Add to `store.go`:

```go
var (
	ErrDuplicate        = errors.New("already exists")
	ErrForeignReference = errors.New("referenced record belongs to another workspace")
)

// mapErr already converts pgx.ErrNoRows; extend it to catch unique violations
// so handlers can answer 409 without inspecting driver errors.
func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrDuplicate
	}
	return err
}
```

- [ ] **Step 4: Implement the label handlers**

`api/internal/api/label.go`. Map `store.ErrDuplicate` to 409 `conflict`, `store.ErrForeignReference` to 400 `invalid_request`. Validate `color` against `^#[0-9a-fA-F]{6}$`. Require `admin` or `member` for mutations.

Extend `GetIssueByKey` in `issue.go` to populate `Labels` if not already done in Task 7.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Label -v`
Expected: PASS, all four tests.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "Add labels and issue label assignment"
```

---

### Task 9: Comments and mentions

**Files:**
- Create: `api/internal/store/comment.go`, `api/internal/store/mention.go`, `api/internal/api/comment.go`, `api/internal/api/comment_test.go`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Consumes: `store.RecordActivity`, membership lookup.
- Produces:
  - `store.Comment{ID, WorkspaceID uuid.UUID; TargetType string; TargetID uuid.UUID; ParentID *uuid.UUID; Author User; Body, CreatedAt string; EditedAt, DeletedAt *string; Replies []Comment}`
  - `(*Store).CreateComment(ctx, in CreateCommentInput) (Comment, error)` with `CreateCommentInput{WorkspaceID, ActorID uuid.UUID; TargetType string; TargetID uuid.UUID; ParentID *uuid.UUID; Body string}`
  - `(*Store).ListComments(ctx, workspaceID uuid.UUID, targetType string, targetID uuid.UUID) ([]Comment, error)` - top-level comments with their replies nested.
  - `(*Store).UpdateComment(ctx, workspaceID, id, actorID uuid.UUID, body string) (Comment, error)` - only the author may edit.
  - `(*Store).DeleteComment(ctx, workspaceID, id, actorID uuid.UUID) error` - soft delete; author or admin.
  - `(*Store).ListMentions(ctx, workspaceID, userID uuid.UUID, unreadOnly bool) ([]Mention, error)` with `Mention{Comment Comment; ReadAt *string}`
  - `(*Store).MarkMentionsRead(ctx, workspaceID, userID uuid.UUID, commentIDs []uuid.UUID) error`
  - `store.ParseMentions(body string) []string` - returns the distinct lowercase logins named with `@`.
  - `store.ErrForbidden` for an author-only action attempted by someone else.
- Routes: `GET/POST /api/v1/w/{slug}/issues/{key}/comments`, `GET/POST /api/v1/w/{slug}/milestones/{id}/comments`, `PATCH/DELETE /api/v1/w/{slug}/comments/{id}`, `GET /api/v1/w/{slug}/mentions`, `POST /api/v1/w/{slug}/mentions/read`.

- [ ] **Step 1: Write the failing mention parser test**

Add to `api/internal/store/comment_test.go`:

```go
package store_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		body string
		want []string
	}{
		{"no mentions here", nil},
		{"hey @sabari take a look", []string{"sabari"}},
		{"@Sabari and @sabari are the same person", []string{"sabari"}},
		{"@one @two-dash @three", []string{"one", "two-dash", "three"}},
		{"email me at me@example.com", nil},
		{"`@notmention` in code", nil},
	}
	for _, c := range cases {
		require.Equal(t, c.want, store.ParseMentions(c.body), "body: %s", c.body)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/store/ -run ParseMentions`
Expected: FAIL - undefined `store.ParseMentions`.

- [ ] **Step 3: Implement the mention parser**

`api/internal/store/mention.go`:

```go
package store

import (
	"regexp"
	"strings"
)

// A mention is an @login at a word boundary. The leading boundary class keeps
// an email address like me@example.com from parsing as a mention, and inline
// code spans are stripped first so a documented handle is not a notification.
var (
	codeSpanRe = regexp.MustCompile("`[^`]*`")
	mentionRe  = regexp.MustCompile(`(^|[^A-Za-z0-9_./-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))`)
)

func ParseMentions(body string) []string {
	clean := codeSpanRe.ReplaceAllString(body, " ")

	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(clean, -1) {
		login := strings.ToLower(m[2])
		if seen[login] {
			continue
		}
		seen[login] = true
		out = append(out, login)
	}
	return out
}
```

- [ ] **Step 4: Run the parser test and verify it passes**

Run: `cd api && go test ./internal/store/ -run ParseMentions -v`
Expected: PASS.

- [ ] **Step 5: Write the failing comment API test**

`api/internal/api/comment_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCommentOnIssueRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Started on this today."})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var c store.Comment
	f.DecodeInto(rec, &c)
	require.Equal(t, "Started on this today.", c.Body)
	require.Equal(t, f.User.ID, c.Author.ID)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbCommented, c.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestRepliesNestOneLevelOnly(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Top level"})
	var top store.Comment
	f.DecodeInto(rec, &top)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Reply", "parent_id": top.ID.String()})
	require.Equal(t, http.StatusCreated, rec.Code)
	var reply store.Comment
	f.DecodeInto(rec, &reply)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Nested too deep", "parent_id": reply.ID.String()})
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	var list struct {
		Comments []store.Comment `json:"comments"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Comments, 1)
	require.Len(t, list.Comments[0].Replies, 1)
}

func TestMentionCreatesAnUnreadMention(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "@sabari can you review?"})
	require.Equal(t, http.StatusCreated, rec.Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/mentions?unread=true", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "can you review")
}

func TestMentionOfANonMemberIsIgnored(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "@stranger please look"})
	require.Equal(t, http.StatusCreated, rec.Code,
		"an unknown handle must not fail the comment")

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM comment_mention`).Scan(&count))
	require.Equal(t, 0, count)
}

func TestOnlyTheAuthorCanEditAComment(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Mine"})
	var c store.Comment
	f.DecodeInto(rec, &c)

	// A second member of the same workspace must not be able to edit it.
	other, err := f.Store.UpsertUserByGitHub(t.Context(),
		store.GitHubIdentity{ID: 2002, Login: "other"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'other', 'member')`, f.WorkspaceID, other.ID)
	require.NoError(t, err)

	original := f.Token
	token, err := f.Store.CreateSession(t.Context(), other.ID, time.Hour)
	require.NoError(t, err)
	f.Token = token
	defer func() { f.Token = original }()

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/comments/"+c.ID.String(),
		map[string]any{"body": "Hijacked"})
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestDeletedCommentIsHiddenButPreserved(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "Delete me"})
	var c store.Comment
	f.DecodeInto(rec, &c)

	require.Equal(t, http.StatusNoContent,
		f.Do(http.MethodDelete, "/api/v1/w/lab/comments/"+c.ID.String(), nil).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	require.NotContains(t, rec.Body.String(), "Delete me")

	var stillThere int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM comment WHERE id = $1 AND deleted_at IS NOT NULL`,
		c.ID).Scan(&stillThere))
	require.Equal(t, 1, stillThere, "the row is retained for the audit trail")
}
```

Add `"time"` to the test file imports.

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Comment`
Expected: FAIL - `store.Comment` undefined.

- [ ] **Step 7: Implement the comment store**

`api/internal/store/comment.go`. `CreateComment` runs one transaction that inserts the comment, records `VerbCommented` activity with metadata `{"target_type":..., "excerpt": first 140 characters of the body}`, resolves parsed mentions to workspace members only, and inserts `comment_mention` rows:

```sql
INSERT INTO comment_mention (comment_id, user_id)
SELECT $1, u.id
FROM app_user u
JOIN membership m ON m.user_id = u.id AND m.workspace_id = $2
WHERE lower(u.github_login) = ANY($3::text[])
ON CONFLICT DO NOTHING
```

A mention of someone who is not a member simply inserts nothing, so an unknown handle never fails the comment.

Translate the `comment_depth_guard` trigger error to `ErrInvalidNesting`, the same way Task 7 translates the issue guard.

`ListComments` selects non-deleted comments joined to their authors, ordered by `created_at`, and nests replies under their parents in Go.

`UpdateComment` and `DeleteComment` return `ErrForbidden` when the caller is neither the author nor an admin. Add `var ErrForbidden = errors.New("forbidden")` to `store.go`.

- [ ] **Step 8: Implement the comment handlers**

`api/internal/api/comment.go`. Reject an empty or whitespace-only body with 400. Map `store.ErrForbidden` to 403 and `store.ErrInvalidNesting` to 400. `DELETE` answers 204. The issue routes resolve `{key}` to an issue id first, returning 404 when the key belongs to another workspace.

- [ ] **Step 9: Run the tests and verify they pass**

Run: `cd api && go test ./internal/... -run 'Comment|Mention' -v`
Expected: PASS, all seven tests.

- [ ] **Step 10: Commit**

```bash
git add api
git commit -m "Add comments as the progress log, with one-level replies and mentions"
```

---

### Task 10: Activity feeds and the SSE stream

**Files:**
- Create: `api/internal/api/activity.go`, `api/internal/api/activity_test.go`, `api/internal/api/stream.go`, `api/internal/api/stream_test.go`
- Modify: `api/internal/store/activity.go`, `api/internal/api/server.go`

**Interfaces:**
- Consumes: everything from Tasks 5-9.
- Produces:
  - `(*Store).ListActivity(ctx, workspaceID uuid.UUID, f ActivityFilter) ([]Activity, string, error)` with `ActivityFilter{ActorID *uuid.UUID; Verbs []string; TargetType string; TargetID *uuid.UUID; Cursor string; Limit int}`, returning the page and the next cursor (the last row's `id` as a decimal string).
  - `(*Store).Dashboard(ctx, workspaceID, userID uuid.UUID) (store.DashboardPayload, error)` with `DashboardPayload{Activity []Activity; MyIssues []Issue; UnreadMentions int; ActiveSprint *Sprint; Milestones []Milestone}`
  - `api.Broker` with `NewBroker() *Broker`, `(*Broker).Subscribe(workspaceID uuid.UUID) (<-chan store.Activity, func())`, `(*Broker).Publish(workspaceID uuid.UUID, a store.Activity)`.
- Routes: `GET /api/v1/w/{slug}/activity`, `GET /api/v1/w/{slug}/dashboard`, `GET /api/v1/w/{slug}/stream`.

- [ ] **Step 1: Write the failing feed test**

`api/internal/api/activity_test.go`:

```go
package api_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestTeamFeedReturnsNewestFirst(t *testing.T) {
	f := testutil.NewFixture(t)
	first := createIssue(t, f, map[string]any{"title": "First"})
	second := createIssue(t, f, map[string]any{"title": "Second"})

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var page struct {
		Activity   []store.Activity `json:"activity"`
		NextCursor string           `json:"next_cursor"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 2)
	require.Equal(t, second.ID, page.Activity[0].TargetID)
	require.Equal(t, first.ID, page.Activity[1].TargetID)
	require.Equal(t, f.User.ID, page.Activity[0].Actor.ID)
}

func TestFeedPaginatesWithACursor(t *testing.T) {
	f := testutil.NewFixture(t)
	for i := 0; i < 5; i++ {
		createIssue(t, f, map[string]any{"title": fmt.Sprintf("Issue %d", i)})
	}

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity?limit=2", nil)
	var page struct {
		Activity   []store.Activity `json:"activity"`
		NextCursor string           `json:"next_cursor"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 2)
	require.NotEmpty(t, page.NextCursor)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/activity?limit=2&cursor="+page.NextCursor, nil)
	var next struct {
		Activity []store.Activity `json:"activity"`
	}
	f.DecodeInto(rec, &next)
	require.Len(t, next.Activity, 2)
	require.Less(t, next.Activity[0].ID, page.Activity[1].ID,
		"the second page must continue below the first")
}

func TestFeedFiltersByActor(t *testing.T) {
	f := testutil.NewFixture(t)
	createIssue(t, f, map[string]any{"title": "Mine"})

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity?actor_id="+f.User.ID.String(), nil)
	var page struct {
		Activity []store.Activity `json:"activity"`
	}
	f.DecodeInto(rec, &page)
	require.Len(t, page.Activity, 1)

	other := "00000000-0000-0000-0000-000000000009"
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/activity?actor_id="+other, nil)
	f.DecodeInto(rec, &page)
	require.Empty(t, page.Activity)
}

func TestDashboardReturnsMyWorkAndMentions(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)

	issue := createIssue(t, f, map[string]any{
		"title": "Mine", "assignee_id": f.User.ID.String(), "status": "in_progress"})
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
			map[string]any{"body": "@sabari look at this"}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/dashboard", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var dash store.DashboardPayload
	f.DecodeInto(rec, &dash)
	require.Len(t, dash.MyIssues, 1)
	require.Equal(t, issue.Key, dash.MyIssues[0].Key)
	require.Equal(t, 1, dash.UnreadMentions)
	require.NotNil(t, dash.ActiveSprint)
	require.NotEmpty(t, dash.Activity)
}

func TestActivityOfAnotherWorkspaceIsInvisible(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO activity (workspace_id, verb, target_type, target_id, metadata)
		VALUES ($1, 'created_issue', 'issue', gen_random_uuid(), '{"title":"Secret"}')`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/activity", nil)
	require.NotContains(t, rec.Body.String(), "Secret")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run 'Feed|Dashboard|Activity'`
Expected: FAIL - route not found, `DashboardPayload` undefined.

- [ ] **Step 3: Implement the feed queries**

Extend `api/internal/store/activity.go` with `ListActivity` and `Dashboard`.

`ListActivity` joins the actor and paginates descending on the primary key, which is monotonic and therefore a stable cursor even when two rows share a timestamp:

```sql
SELECT a.id, a.workspace_id, a.verb, a.target_type, a.target_id, a.metadata,
       to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
       u.id, u.github_id, u.github_login, u.name, u.avatar_url
FROM activity a
LEFT JOIN app_user u ON u.id = a.actor_id
WHERE a.workspace_id = $1
  AND ($2::uuid IS NULL OR a.actor_id = $2)
  AND ($3::text[] IS NULL OR a.verb = ANY($3))
  AND ($4::bigint IS NULL OR a.id < $4)
ORDER BY a.id DESC
LIMIT $5
```

`Dashboard` runs the four reads concurrently is unnecessary at this scale; run them sequentially in one function: the caller's recent activity (limit 20), their open issues (`assignee_id = user AND status NOT IN ('done','cancelled')`), the unread mention count, and the active sprint with its milestones.

- [ ] **Step 4: Implement the feed handlers**

`api/internal/api/activity.go`. Parse `limit` (default 30, max 100), `cursor`, `actor_id`, repeated `verb`, `target_type`, and `target_id`. Return `{"activity": [...], "next_cursor": "..."}`, with `next_cursor` empty when the page is not full.

- [ ] **Step 5: Write the failing SSE test**

`api/internal/api/stream_test.go`:

```go
package api_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestStreamDeliversNewActivity(t *testing.T) {
	f := testutil.NewFixture(t)

	srv := httptest.NewServer(f.Handler)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/w/lab/stream", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/event-stream", strings.Split(resp.Header.Get("Content-Type"), ";")[0])

	reader := bufio.NewReader(resp.Body)
	// The server sends a comment line immediately so the client knows it is
	// connected rather than waiting on a proxy buffer.
	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(line, ":"), "got %q", line)

	go func() {
		time.Sleep(200 * time.Millisecond)
		createIssue(t, f, map[string]any{"title": "Streamed"})
	}()

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		if strings.HasPrefix(line, "data:") && strings.Contains(line, "created_issue") {
			return
		}
	}
	t.Fatal("no activity event arrived on the stream")
}

func TestStreamRequiresMembership(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/w/lab/stream", nil)
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Stream`
Expected: FAIL - the stream route does not exist.

- [ ] **Step 7: Implement the broker and the SSE handler**

`api/internal/api/stream.go`:

```go
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// Broker fans activity out to connected browsers. It is intentionally
// in-process: a dropped event costs a client one refresh, never data, so a
// durable bus would be complexity without a matching risk.
type Broker struct {
	mu   sync.RWMutex
	subs map[uuid.UUID]map[chan store.Activity]struct{}
}

func NewBroker() *Broker {
	return &Broker{subs: make(map[uuid.UUID]map[chan store.Activity]struct{})}
}

func (b *Broker) Subscribe(workspaceID uuid.UUID) (<-chan store.Activity, func()) {
	ch := make(chan store.Activity, 16)
	b.mu.Lock()
	if b.subs[workspaceID] == nil {
		b.subs[workspaceID] = make(map[chan store.Activity]struct{})
	}
	b.subs[workspaceID][ch] = struct{}{}
	b.mu.Unlock()

	return ch, func() {
		b.mu.Lock()
		delete(b.subs[workspaceID], ch)
		if len(b.subs[workspaceID]) == 0 {
			delete(b.subs, workspaceID)
		}
		b.mu.Unlock()
		close(ch)
	}
}

// Publish never blocks: a subscriber too slow to keep up drops the event
// rather than stalling the request that produced it.
func (b *Broker) Publish(workspaceID uuid.UUID, a store.Activity) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs[workspaceID] {
		select {
		case ch <- a:
		default:
		}
	}
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	events, unsubscribe := s.broker.Subscribe(ws.WorkspaceID)
	defer unsubscribe()

	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case ev := <-events:
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: activity\ndata: %s\n\n", payload)
			flusher.Flush()
		}
	}
}
```

- [ ] **Step 8: Publish activity from the mutating handlers**

Add a `broker *Broker` field to `Server`, initialised in `NewServer`.

After each successful mutation (create issue, update issue, comment, close sprint, complete milestone), read back the activity rows just written for that target and publish them. Implement it once as a helper so no handler forgets:

```go
// publishRecent republishes the activity rows written above a known id, so a
// handler only has to remember the id it saw before the mutation.
func (s *Server) publishRecent(ctx context.Context, workspaceID uuid.UUID, sinceID int64) {
	rows, _, err := s.store.ListActivity(ctx, workspaceID, store.ActivityFilter{Limit: 10})
	if err != nil {
		return
	}
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].ID > sinceID {
			s.broker.Publish(workspaceID, rows[i])
		}
	}
}
```

Capture `sinceID` with `s.store.LatestActivityID(ctx, workspaceID)` before the mutation. Add that method to `store/activity.go`:

```go
func (s *Store) LatestActivityID(ctx context.Context, workspaceID uuid.UUID) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(max(id), 0) FROM activity WHERE workspace_id = $1`, workspaceID).Scan(&id)
	return id, err
}
```

Register the route: `mux.Handle("GET /api/v1/w/{slug}/stream", s.RequireWorkspace(http.HandlerFunc(s.handleStream)))`.

- [ ] **Step 9: Run the whole suite and verify it passes**

Run: `cd api && go build ./... && go vet ./... && go test ./...`
Expected: PASS for every package.

- [ ] **Step 10: Commit**

```bash
git add api
git commit -m "Add activity feeds, dashboard payload, and SSE stream"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 2. Users and access, OAuth, invite gate, roles | 3 |
| 4. Hierarchy: sprint, milestone, issue | 1, 5, 6, 7 |
| 4. Fixed status enum, one-level sub-issues | 1 (triggers), 7 |
| 4. Fractional index positions | 4, 6, 7 |
| 4. Labels | 1, 8 |
| 4. Comments, one-level replies, mentions | 1, 9 |
| 4. Activity as the single stream | 4, 10 |
| 6. My Dashboard, Team Feed | 10 |
| 3. SSE realtime | 10 |
| 5. GitHub integration | plan 2 |
| 4. Sprint snapshot on close | plan 3, with `closed_sprint` activity landing in task 5 |
| 6. Views, 7. Visual design | plan 3 |
| 8. Reports | plan 3 |
| 10. Delivery | plan 3 |

**Deliberately deferred to later plans:** the GitHub tables and worker (plan 2), and `sprint_snapshot`, reports, the SPA, and Compose (plan 3). Every other spec requirement has a task above.

**Type consistency check:** `store.Store` is the single receiver for all queries; every store method takes `ctx` then `workspaceID`. `RecordActivity` is a package function taking `pgx.Tx` because it must join an existing transaction. `Issue.Key` is used consistently as the URL path parameter, while sprints and milestones use `{id}` UUIDs.
