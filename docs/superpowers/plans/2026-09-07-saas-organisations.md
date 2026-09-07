# Self-Serve Organisations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in with an emailed magic link, create organisations, invite colleagues by email, and connect GitHub from inside an organisation, on top of the existing sprint, issue, and evidence features.

**Architecture:** Email replaces GitHub as identity; every token (login, invite, App setup state) is random, hashed at rest, expiring, single use, following the existing session pattern. A `mail` package with a Resend and a log implementation sends the two mails. The GitHub App becomes public and an organisation binds an installation through the App setup callback; the worker's installation events then keep repositories in sync. The GitHub OAuth flow is kept only to link a GitHub account to a signed-in user.

**Tech Stack:** Go 1.26, pgx v5, Postgres 18, testcontainers; React 19, TanStack Query and Router, Tailwind, Vitest; Playwright against the Compose stack; Resend HTTP API.

**Spec:** `docs/superpowers/specs/2026-09-07-saas-organisations-design.md`

## Global Constraints

- Module path `github.com/NarayanaSabari/velvet-otter-lab/api`; run Go commands from `api/`, web commands from `web/`, Playwright from `e2e/`.
- Tokens are 32 random bytes, `base64.RawURLEncoding`, stored as `store.HashToken` (SHA-256 hex). Login tokens expire in 15 minutes, invites in 7 days, setup states in 15 minutes. All single use.
- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (3 to 40 chars), not in the reserved list `admin api auth check-email expired invite invites me new orgs settings signin signout w webhooks`.
- Issue prefix: `^[A-Z]{2,6}$`.
- Interface copy says "organisation", never "workspace". Go identifiers and table names keep `workspace`.
- Every error response keeps the `{"error":{"code","message"}}` envelope via `api.WriteError`.
- Sign-in requests: at most 5 per email address and 20 per client IP in any 15 minute window, counted in Postgres.
- Production (`BASE_URL` starting `https://`) refuses to start without `RESEND_API_KEY` and `MAIL_FROM`.
- Commit messages describe the change in one sentence, no trailers, no tool names.
- `docker compose exec` inside `ssh ... bash -s` scripts must take `</dev/null`, or it eats the rest of the script.
- The spec's single migration is delivered as two files: `0005_organisations.sql` adds everything, `0006_email_identity.sql` removes `invited_login` and tightens constraints after the code stops using them. The migration runner applies both in order, so a fresh database ends in the spec's state.

---

## File map

Created:
- `api/internal/db/migrations/0005_organisations.sql` - new tables and nullable columns.
- `api/internal/db/migrations/0006_email_identity.sql` - `NOT NULL` email, drop `invited_login`.
- `api/internal/mail/mail.go` - `Mailer` interface, `Message`, `LogMailer`.
- `api/internal/mail/resend.go` - Resend implementation.
- `api/internal/mail/templates.go` - the two mails.
- `api/internal/mail/mail_test.go`, `resend_test.go`.
- `api/internal/store/login_token.go` - issue and consume login tokens, rate counts.
- `api/internal/store/workspace.go` - create, delete, leave, member management, slug validation.
- `api/internal/store/invite.go` - invites.
- `api/internal/store/github_setup.go` - setup states, installation binding, repository sync.
- `api/internal/api/email_auth.go` - `POST /auth/email`, `GET /auth/magic`.
- `api/internal/api/org.go` - `POST /orgs`, delete, leave, member role and removal.
- `api/internal/api/invite.go` - invite endpoints.
- `api/internal/api/github_setup.go` - connect redirect and setup callback.
- `api/internal/api/github_link.go` - link and unlink a GitHub account.
- `web/src/features/auth/EmailSignIn.tsx`, `CheckEmail.tsx`, `Expired.tsx`.
- `web/src/features/orgs/NewOrg.tsx`, `Landing.tsx`, `AcceptInvite.tsx`.
- `web/src/features/admin/InvitePanel.tsx`, `GitHubPanel.tsx`, `DangerPanel.tsx`.
- `web/src/features/profile/Profile.tsx`.
- `e2e/tests/onboarding.spec.ts`.

Modified:
- `api/internal/config/config.go` - mail and App slug settings, production check.
- `api/internal/store/user.go` - email identity, GitHub link and unlink.
- `api/internal/store/pull_request.go` - `ReposDueForSync` skips suspended installations.
- `api/internal/api/server.go` - constructor takes mailer and GitHub client; new route groups.
- `api/internal/api/auth.go` - GitHub login removed; `/me` gains `last_workspace`; `RequireWorkspace` records it.
- `api/internal/api/membership.go` - invite-by-login endpoint removed.
- `api/internal/api/github.go` - `POST /repos` removed.
- `api/internal/github/client.go` - installation and repository lookups.
- `api/internal/worker/installation.go` - repository add, remove, suspend, delete.
- `api/internal/testutil/fixtures.go` - users by email.
- `api/cmd/ticket/main.go` - wiring.
- `web/src/lib/types.ts`, `web/src/routes/router.tsx`, `web/src/routes/root.tsx`, `web/src/app/Shell.tsx`, `web/src/features/auth/useSession.ts`, `web/src/features/admin/Admin.tsx`.
- `e2e/tests/fixtures.ts`, `e2e/stack-up.sh`.
- `deploy/docker-compose.yml`, `README.md`.

Deleted:
- `api/internal/api/membership.go` invite handler and `store.InviteWorkspaceMember`, `store.BindMembership`.
- `web/src/features/auth/NotInvited.tsx`, `web/src/features/auth/SignIn.tsx`.
- `deploy/bootstrap.sh`, `deploy/invite.sh`, `deploy/connect-repo.sh`.

---

### Task 1: Additive migration

**Files:**
- Create: `api/internal/db/migrations/0005_organisations.sql`
- Test: `api/internal/db/migrate_test.go`

**Interfaces:**
- Produces: tables `login_token`, `invite`, `github_setup_state`; columns `app_user.email`, `github_installation.workspace_id`, `session.last_workspace_id`; `app_user.github_id` and `github_login` nullable.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/db/migrate_test.go`:

```go
func TestMigrateOrganisationsSchema(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()

	var n int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_name IN ('login_token', 'invite', 'github_setup_state')`).Scan(&n))
	require.Equal(t, 3, n, "new tables exist")

	var nullable string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT is_nullable FROM information_schema.columns
		WHERE table_name = 'app_user' AND column_name = 'github_id'`).Scan(&nullable))
	require.Equal(t, "YES", nullable, "github_id is nullable")

	// A user without GitHub is now valid.
	_, err := pool.Exec(ctx, `INSERT INTO app_user (email) VALUES ('a@example.com')`)
	require.NoError(t, err)
	// Email is unique case-insensitively.
	_, err = pool.Exec(ctx, `INSERT INTO app_user (email) VALUES ('A@Example.com')`)
	require.Error(t, err)
}
```

Add imports `context`, `github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil`, and `github.com/stretchr/testify/require` if the file lacks them.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && go test ./internal/db/ -run TestMigrateOrganisationsSchema`
Expected: FAIL, count is 0.

- [ ] **Step 3: Write the migration**

`api/internal/db/migrations/0005_organisations.sql`:

```sql
-- Email becomes the identity; GitHub becomes an optional link on the user.
ALTER TABLE app_user ADD COLUMN email text;
CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email));
ALTER TABLE app_user ALTER COLUMN github_id DROP NOT NULL;
ALTER TABLE app_user ALTER COLUMN github_login DROP NOT NULL;

-- Sign-in links. Only the hash is stored, like sessions.
CREATE TABLE login_token (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  text NOT NULL UNIQUE,
    email       text NOT NULL,
    invite_id   uuid,
    request_ip  text NOT NULL DEFAULT '',
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_token_email_created_idx ON login_token (lower(email), created_at);
CREATE INDEX login_token_ip_created_idx ON login_token (request_ip, created_at);

CREATE TABLE invite (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    email        text NOT NULL,
    role         membership_role NOT NULL DEFAULT 'member',
    token_hash   text NOT NULL UNIQUE,
    invited_by   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- One live invite per address per organisation; re-inviting replaces it.
CREATE UNIQUE INDEX invite_pending_idx ON invite (workspace_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE login_token ADD CONSTRAINT login_token_invite_fkey
    FOREIGN KEY (invite_id) REFERENCES invite(id) ON DELETE CASCADE;

-- An installation belongs to at most one organisation.
ALTER TABLE github_installation
    ADD COLUMN workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;

-- One-time state carried through the App installation page.
CREATE TABLE github_setup_state (
    token_hash   text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session ADD COLUMN last_workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/db/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/db/migrations/0005_organisations.sql api/internal/db/migrate_test.go
git commit -m "Add the organisations schema: email on users, login tokens, invites, setup states"
```

---

### Task 2: Config for mail and the App slug

**Files:**
- Modify: `api/internal/config/config.go`
- Test: `api/internal/config/config_test.go`

**Interfaces:**
- Produces: `Config.ResendAPIKey`, `Config.MailFrom`, `Config.GitHubAppSlug string`; `Load()` returns an error when `BaseURL` starts with `https://` and either mail setting is empty.

- [ ] **Step 1: Write the failing tests**

Append to `config_test.go`:

```go
func TestLoadRequiresMailInProduction(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "https://velvet.example.com")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "RESEND_API_KEY")

	t.Setenv("RESEND_API_KEY", "re_test")
	t.Setenv("MAIL_FROM", "Velvet <noreply@mail.example.com>")
	t.Setenv("GITHUB_APP_SLUG", "velvet-worklog")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "re_test", cfg.ResendAPIKey)
	require.Equal(t, "velvet-worklog", cfg.GitHubAppSlug)
}

func TestLoadAllowsNoMailLocally(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "http://localhost:8088")
	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.ResendAPIKey)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/config/`
Expected: FAIL, `cfg.ResendAPIKey` undefined.

- [ ] **Step 3: Implement**

In `config.go` add fields and validation:

```go
type Config struct {
	// ... existing fields ...
	// Mail is required in production so sign-in cannot silently fall back to
	// logging links; locally the log mailer is the point.
	ResendAPIKey string
	MailFrom     string
	// The App's URL slug, used to send admins to its installation page.
	GitHubAppSlug string
}
```

In `Load()` after building `c`:

```go
	c.ResendAPIKey = os.Getenv("RESEND_API_KEY")
	c.MailFrom = os.Getenv("MAIL_FROM")
	c.GitHubAppSlug = os.Getenv("GITHUB_APP_SLUG")
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if strings.HasPrefix(c.BaseURL, "https://") && (c.ResendAPIKey == "" || c.MailFrom == "") {
		return nil, fmt.Errorf("RESEND_API_KEY and MAIL_FROM are required when BASE_URL is https")
	}
	return c, nil
```

Add `"strings"` to imports.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/config/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/config
git commit -m "Require mail settings in production and add the GitHub App slug"
```

---

### Task 3: Mail package

**Files:**
- Create: `api/internal/mail/mail.go`, `api/internal/mail/resend.go`, `api/internal/mail/templates.go`
- Test: `api/internal/mail/mail_test.go`, `api/internal/mail/resend_test.go`

**Interfaces:**
- Produces:
  ```go
  type Message struct{ To, Subject, Text, HTML string }
  type Mailer interface{ Send(ctx context.Context, m Message) error }
  func NewLogMailer(log *slog.Logger) *LogMailer
  func NewResend(apiKey, from string, httpClient *http.Client, baseURL string) *Resend
  func SignInMessage(to, link string) Message
  func InviteMessage(to, orgName, inviterName, link string) Message
  ```

- [ ] **Step 1: Write the failing tests**

`api/internal/mail/mail_test.go`:

```go
package mail

import (
	"bytes"
	"context"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLogMailerWritesLinks(t *testing.T) {
	var buf bytes.Buffer
	m := NewLogMailer(slog.New(slog.NewTextHandler(&buf, nil)))
	require.NoError(t, m.Send(context.Background(), SignInMessage("a@example.com", "https://x/api/v1/auth/magic?token=abc")))
	out := buf.String()
	require.Contains(t, out, "a@example.com")
	require.Contains(t, out, "https://x/api/v1/auth/magic?token=abc")
}

func TestTemplates(t *testing.T) {
	s := SignInMessage("a@example.com", "https://x/m")
	require.Equal(t, "Your sign-in link", s.Subject)
	require.Contains(t, s.Text, "https://x/m")
	require.Contains(t, s.HTML, `href="https://x/m"`)

	i := InviteMessage("b@example.com", "Velvet", "Sabari", "https://x/invite/t")
	require.Equal(t, "Sabari invited you to Velvet", i.Subject)
	require.Contains(t, i.Text, "https://x/invite/t")
	// Names are escaped in HTML so an inviter cannot inject markup.
	j := InviteMessage("b@example.com", "<b>x</b>", "A", "https://x")
	require.NotContains(t, j.HTML, "<b>x</b>")
}
```

`api/internal/mail/resend_test.go`:

```go
package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestResendPostsMessage(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		require.Equal(t, "/emails", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.WriteHeader(200)
		w.Write([]byte(`{"id":"1"}`))
	}))
	defer srv.Close()

	m := NewResend("re_key", "Velvet <no@x>", srv.Client(), srv.URL)
	require.NoError(t, m.Send(context.Background(), Message{To: "a@x", Subject: "s", Text: "t", HTML: "<p>t</p>"}))
	require.Equal(t, "Bearer re_key", auth)
	require.Equal(t, "Velvet <no@x>", got["from"])
	require.Equal(t, []any{"a@x"}, got["to"])
	require.Equal(t, "s", got["subject"])
}

func TestResendReportsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		w.Write([]byte(`{"message":"bad from"}`))
	}))
	defer srv.Close()
	m := NewResend("k", "f", srv.Client(), srv.URL)
	err := m.Send(context.Background(), Message{To: "a@x"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "422")
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/mail/`
Expected: FAIL to compile, package missing.

- [ ] **Step 3: Implement**

`api/internal/mail/mail.go`:

```go
// Package mail sends the two transactional mails: sign-in links and
// invitations. Production goes through Resend; everything else logs the
// message so tests and local runs can follow the link from the log.
package mail

import (
	"context"
	"log/slog"
	"regexp"
)

type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// LogMailer never delivers. It logs the recipient, subject, and every link
// in the text body at INFO so the end-to-end suite can complete a sign-in.
type LogMailer struct {
	log *slog.Logger
}

func NewLogMailer(log *slog.Logger) *LogMailer { return &LogMailer{log: log} }

var linkRe = regexp.MustCompile(`https?://[^\s<>"]+`)

func (l *LogMailer) Send(_ context.Context, m Message) error {
	links := linkRe.FindAllString(m.Text, -1)
	l.log.Info("mail (not sent)", "to", m.To, "subject", m.Subject, "links", links)
	return nil
}
```

`api/internal/mail/resend.go`:

```go
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const resendBaseURL = "https://api.resend.com"

type Resend struct {
	apiKey  string
	from    string
	http    *http.Client
	baseURL string
}

// NewResend sends through Resend's REST API. baseURL is overridable for tests.
func NewResend(apiKey, from string, httpClient *http.Client, baseURL string) *Resend {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if baseURL == "" {
		baseURL = resendBaseURL
	}
	return &Resend{apiKey: apiKey, from: from, http: httpClient, baseURL: strings.TrimRight(baseURL, "/")}
}

func (r *Resend) Send(ctx context.Context, m Message) error {
	body, err := json.Marshal(map[string]any{
		"from":    r.from,
		"to":      []string{m.To},
		"subject": m.Subject,
		"text":    m.Text,
		"html":    m.HTML,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/emails", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := r.http.Do(req)
	if err != nil {
		return fmt.Errorf("resend: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("resend: status %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}
```

`api/internal/mail/templates.go`:

```go
package mail

import (
	"bytes"
	"fmt"
	"html/template"
)

var signInHTML = template.Must(template.New("signin").Parse(`<p>Click to sign in. The link works once and expires in 15 minutes.</p>
<p><a href="{{.Link}}">Sign in</a></p>
<p>If you did not request this, ignore this mail.</p>`))

var inviteHTML = template.Must(template.New("invite").Parse(`<p>{{.Inviter}} invited you to <strong>{{.Org}}</strong>.</p>
<p><a href="{{.Link}}">Accept the invitation</a></p>
<p>The link expires in 7 days.</p>`))

func SignInMessage(to, link string) Message {
	var html bytes.Buffer
	_ = signInHTML.Execute(&html, map[string]string{"Link": link})
	return Message{
		To:      to,
		Subject: "Your sign-in link",
		Text:    fmt.Sprintf("Click to sign in. The link works once and expires in 15 minutes.\n\n%s\n\nIf you did not request this, ignore this mail.\n", link),
		HTML:    html.String(),
	}
}

func InviteMessage(to, orgName, inviterName, link string) Message {
	var html bytes.Buffer
	_ = inviteHTML.Execute(&html, map[string]string{"Org": orgName, "Inviter": inviterName, "Link": link})
	return Message{
		To:      to,
		Subject: fmt.Sprintf("%s invited you to %s", inviterName, orgName),
		Text:    fmt.Sprintf("%s invited you to %s.\n\nAccept the invitation:\n%s\n\nThe link expires in 7 days.\n", inviterName, orgName, link),
		HTML:    html.String(),
	}
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd api && go test ./internal/mail/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/mail
git commit -m "Add the mail package: Resend for production, a log mailer for everything else"
```

---

### Task 4: Store: users by email and login tokens

**Files:**
- Modify: `api/internal/store/user.go`
- Create: `api/internal/store/login_token.go`
- Test: `api/internal/store/login_token_test.go`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces:
  ```go
  // user.go
  type User struct{ ID uuid.UUID; Email string; GitHubID int64; GitHubLogin, Name, AvatarURL string }  // GitHubID 0 and GitHubLogin "" mean unlinked
  func (s *Store) UpsertUserByEmail(ctx, email string) (User, error)
  func (s *Store) UserByEmail(ctx, email string) (User, error)
  func (s *Store) LinkGitHub(ctx, userID uuid.UUID, gh GitHubIdentity) (User, error)   // ErrDuplicate if linked elsewhere
  func (s *Store) UnlinkGitHub(ctx, userID uuid.UUID) error
  // login_token.go
  var ErrRateLimited = errors.New("rate limited")
  type LoginToken struct{ ID uuid.UUID; Email string; InviteID *uuid.UUID }
  func (s *Store) IssueLoginToken(ctx, email, ip string, inviteID *uuid.UUID) (token string, err error)
  func (s *Store) ConsumeLoginToken(ctx, token string) (LoginToken, error)  // ErrNotFound when missing, used, or expired
  ```
  Existing `UpsertUserByGitHub` is deleted in Task 7; until then it stays.

- [ ] **Step 1: Write the failing tests**

`api/internal/store/login_token_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestUpsertUserByEmailIsCaseInsensitive(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	a, err := st.UpsertUserByEmail(ctx, "Sabari@Example.com")
	require.NoError(t, err)
	b, err := st.UpsertUserByEmail(ctx, "sabari@example.com")
	require.NoError(t, err)
	require.Equal(t, a.ID, b.ID)
	require.Equal(t, "sabari@example.com", b.Email, "stored lowercased")
	require.Zero(t, b.GitHubID)
}

func TestLoginTokenLifecycle(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()

	tok, err := st.IssueLoginToken(ctx, "a@example.com", "10.0.0.1", nil)
	require.NoError(t, err)
	require.NotEmpty(t, tok)

	lt, err := st.ConsumeLoginToken(ctx, tok)
	require.NoError(t, err)
	require.Equal(t, "a@example.com", lt.Email)
	require.Nil(t, lt.InviteID)

	_, err = st.ConsumeLoginToken(ctx, tok)
	require.ErrorIs(t, err, store.ErrNotFound, "single use")

	_, err = st.ConsumeLoginToken(ctx, "nope")
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestLoginTokenExpiry(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()
	tok, err := st.IssueLoginToken(ctx, "a@example.com", "", nil)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE login_token SET expires_at = now() - interval '1 minute'`)
	require.NoError(t, err)
	_, err = st.ConsumeLoginToken(ctx, tok)
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestLoginTokenRateLimits(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		_, err := st.IssueLoginToken(ctx, "a@example.com", "10.0.0.1", nil)
		require.NoError(t, err)
	}
	_, err := st.IssueLoginToken(ctx, "A@example.com", "10.0.0.2", nil)
	require.ErrorIs(t, err, store.ErrRateLimited, "sixth for the same address")

	for i := 0; i < 15; i++ {
		_, err := st.IssueLoginToken(ctx, "u"+string(rune('a'+i))+"@example.com", "10.0.0.9", nil)
		require.NoError(t, err)
	}
	// 15 here plus 0 earlier from this IP, so 5 more are fine and the 21st fails.
	for i := 0; i < 5; i++ {
		_, err := st.IssueLoginToken(ctx, "v"+string(rune('a'+i))+"@example.com", "10.0.0.9", nil)
		require.NoError(t, err)
	}
	_, err = st.IssueLoginToken(ctx, "w@example.com", "10.0.0.9", nil)
	require.ErrorIs(t, err, store.ErrRateLimited, "21st from one IP")
}

func TestLinkGitHub(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	a, _ := st.UpsertUserByEmail(ctx, "a@example.com")
	b, _ := st.UpsertUserByEmail(ctx, "b@example.com")

	linked, err := st.LinkGitHub(ctx, a.ID, store.GitHubIdentity{ID: 7, Login: "sabari", Name: "S", AvatarURL: "u"})
	require.NoError(t, err)
	require.Equal(t, "sabari", linked.GitHubLogin)

	_, err = st.LinkGitHub(ctx, b.ID, store.GitHubIdentity{ID: 7, Login: "sabari"})
	require.ErrorIs(t, err, store.ErrDuplicate, "same GitHub account cannot link twice")

	require.NoError(t, st.UnlinkGitHub(ctx, a.ID))
	again, err := st.UserByEmail(ctx, "a@example.com")
	require.NoError(t, err)
	require.Zero(t, again.GitHubID)
	require.Empty(t, again.GitHubLogin)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/store/ -run 'TestUpsertUserByEmail|TestLoginToken|TestLinkGitHub'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the user changes**

In `user.go`, change `User` and every select of user columns. The struct:

```go
type User struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	GitHubID    int64     `json:"github_id"`
	GitHubLogin string    `json:"github_login"`
	Name        string    `json:"name"`
	AvatarURL   string    `json:"avatar_url"`
}

// userCols is the select list every user read uses. GitHub columns are
// nullable now, so they are coalesced to the zero value meaning "not linked".
const userCols = `u.id, COALESCE(u.email, ''), COALESCE(u.github_id, 0), COALESCE(u.github_login, ''), u.name, u.avatar_url`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.GitHubID, &u.GitHubLogin, &u.Name, &u.AvatarURL)
	return u, mapErr(err)
}
```

Replace every `SELECT ... id, github_id, github_login, name, avatar_url` for users in `user.go` (`UserBySessionToken`, `ListWorkspaceMembers`, the `ListWorkspaceMemberships` join, and `UpsertUserByGitHub`'s `RETURNING`) with `userCols` and `scanUser`, aliasing the table as `u`. For `UpsertUserByGitHub` write `RETURNING id, COALESCE(email, ''), COALESCE(github_id, 0), COALESCE(github_login, ''), name, avatar_url`.

Add:

```go
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// UpsertUserByEmail returns the user for an address, creating it on first
// sign-in. Addresses are stored lowercased so the unique index and lookups
// agree without every caller remembering to fold case.
func (s *Store) UpsertUserByEmail(ctx context.Context, email string) (User, error) {
	email = normalizeEmail(email)
	// ON CONFLICT cannot target an expression index directly, so do a read
	// first and race-protect the insert with the index.
	u, err := s.UserByEmail(ctx, email)
	if err == nil {
		return u, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return User{}, err
	}
	u, err = scanUser(s.pool.QueryRow(ctx, `
		INSERT INTO app_user AS u (email) VALUES ($1)
		RETURNING `+userCols, email))
	if errors.Is(err, ErrDuplicate) {
		return s.UserByEmail(ctx, email)
	}
	return u, err
}

func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `
		SELECT `+userCols+` FROM app_user u WHERE lower(u.email) = $1`, normalizeEmail(email)))
}

// LinkGitHub attaches a GitHub identity to a user. ErrDuplicate when that
// GitHub account is already linked to a different user.
func (s *Store) LinkGitHub(ctx context.Context, userID uuid.UUID, gh GitHubIdentity) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `
		UPDATE app_user AS u
		SET github_id = $2, github_login = $3,
		    name = CASE WHEN u.name = '' THEN $4 ELSE u.name END,
		    avatar_url = $5, updated_at = now()
		WHERE u.id = $1
		RETURNING `+userCols, userID, gh.ID, gh.Login, gh.Name, gh.AvatarURL))
}

func (s *Store) UnlinkGitHub(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE app_user SET github_id = NULL, github_login = NULL, updated_at = now() WHERE id = $1`, userID)
	return err
}
```

`mapErr` already turns the unique violation on `github_id` into `ErrDuplicate`.

- [ ] **Step 4: Implement login tokens**

`api/internal/store/login_token.go`:

```go
package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"
)

var ErrRateLimited = errors.New("rate limited")

const (
	LoginTokenTTL     = 15 * time.Minute
	rateWindow        = 15 * time.Minute
	maxPerEmail       = 5
	maxPerIP          = 20
)

type LoginToken struct {
	ID       uuid.UUID
	Email    string
	InviteID *uuid.UUID
}

// NewToken returns a 32-byte random token in URL-safe base64. Callers store
// HashToken(token) and mail the token itself.
func NewToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// IssueLoginToken creates a sign-in token for an address. The limits are
// counted from stored rows so they survive restarts and multiple API
// processes; an empty ip is counted like any other value.
func (s *Store) IssueLoginToken(ctx context.Context, email, ip string, inviteID *uuid.UUID) (string, error) {
	email = normalizeEmail(email)
	var byEmail, byIP int
	err := s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM login_token WHERE lower(email) = $1 AND created_at > now() - $3::interval),
		  (SELECT count(*) FROM login_token WHERE request_ip = $2 AND created_at > now() - $3::interval)`,
		email, ip, rateWindow.String()).Scan(&byEmail, &byIP)
	if err != nil {
		return "", err
	}
	if byEmail >= maxPerEmail || byIP >= maxPerIP {
		return "", ErrRateLimited
	}
	token, err := NewToken()
	if err != nil {
		return "", err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO login_token (token_hash, email, request_ip, invite_id, expires_at)
		VALUES ($1, $2, $3, $4, now() + $5::interval)`,
		HashToken(token), email, ip, inviteID, LoginTokenTTL.String())
	if err != nil {
		return "", err
	}
	return token, nil
}

// ConsumeLoginToken marks a token used and returns what it was issued for.
// Missing, used, and expired all read as ErrNotFound: the caller shows one
// "expired" page and must not reveal which.
func (s *Store) ConsumeLoginToken(ctx context.Context, token string) (LoginToken, error) {
	var lt LoginToken
	err := s.pool.QueryRow(ctx, `
		UPDATE login_token SET consumed_at = now()
		WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		RETURNING id, email, invite_id`, HashToken(token)).Scan(&lt.ID, &lt.Email, &lt.InviteID)
	return lt, mapErr(err)
}
```

Make `CreateSession` in `user.go` use `NewToken()` instead of its inline byte generation, so there is one token helper.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go test ./internal/store/`
Expected: PASS, including the existing suite.

- [ ] **Step 6: Commit**

```bash
git add api/internal/store
git commit -m "Store users by email and issue single-use sign-in tokens with rate limits"
```

---

### Task 5: Email sign-in endpoints

**Files:**
- Create: `api/internal/api/email_auth.go`
- Modify: `api/internal/api/server.go`, `api/internal/api/auth.go`, `api/internal/testutil/fixtures.go`, `api/cmd/ticket/main.go`
- Test: `api/internal/api/email_auth_test.go`

**Interfaces:**
- Consumes: `store.IssueLoginToken`, `store.ConsumeLoginToken`, `store.UpsertUserByEmail`, `mail.Mailer`, `mail.SignInMessage`.
- Produces:
  ```go
  type Deps struct{ Mailer mail.Mailer; GitHub *github.Client }   // github used from Task 9
  func NewServer(pool *pgxpool.Pool, cfg *config.Config, deps Deps) *Server
  ```
  `POST /api/v1/auth/email` body `{"email"}` always 202 `{"status":"sent"}` (400 only for a malformed address). `GET /api/v1/auth/magic?token=` sets the cookie and redirects to `/`; on failure redirects to `/expired`. In tests the fixture uses a `RecordingMailer` exposing `Sent []mail.Message`.

- [ ] **Step 1: Write the failing tests**

`api/internal/api/email_auth_test.go`:

```go
package api_test

import (
	"net/http"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

var magicLinkRe = regexp.MustCompile(`/api/v1/auth/magic\?token=([A-Za-z0-9_-]+)`)

func TestEmailSignInIssuesSession(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "New@Example.com"})
	require.Equal(t, http.StatusAccepted, rec.Code)
	require.Len(t, f.Mailer.Sent, 1)
	require.Equal(t, "new@example.com", f.Mailer.Sent[0].To)
	m := magicLinkRe.FindStringSubmatch(f.Mailer.Sent[0].Text)
	require.NotNil(t, m, "mail carries the magic link")

	rec = f.DoAnon(http.MethodGet, "/api/v1/auth/magic?token="+m[1], nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Equal(t, "/", rec.Header().Get("Location"))
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName {
			cookie = c
		}
	}
	require.NotNil(t, cookie)
	require.True(t, cookie.HttpOnly)

	// The cookie is a real session.
	req := f.Request(http.MethodGet, "/api/v1/me", nil)
	req.AddCookie(cookie)
	rec = f.Serve(req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"email":"new@example.com"`)

	// Second use fails closed.
	rec = f.DoAnon(http.MethodGet, "/api/v1/auth/magic?token="+m[1], nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Equal(t, "/expired", rec.Header().Get("Location"))
}

func TestEmailSignInHidesUnknownAddresses(t *testing.T) {
	f := testutil.NewFixture(t)
	a := f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": f.User.Email})
	b := f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "stranger@example.com"})
	require.Equal(t, a.Code, b.Code)
	require.Equal(t, a.Body.String(), b.Body.String())
}

func TestEmailSignInRejectsMalformedAndRateLimits(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "not-an-address"})
	require.Equal(t, http.StatusBadRequest, rec.Code)

	for i := 0; i < 5; i++ {
		rec = f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "x@example.com"})
		require.Equal(t, http.StatusAccepted, rec.Code)
	}
	rec = f.DoAnon(http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "x@example.com"})
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
}
```

- [ ] **Step 2: Extend the fixture**

In `api/internal/testutil/fixtures.go`:

```go
// RecordingMailer keeps every message so tests can follow the links.
type RecordingMailer struct{ Sent []mail.Message }

func (m *RecordingMailer) Send(_ context.Context, msg mail.Message) error {
	m.Sent = append(m.Sent, msg)
	return nil
}
```

Add `Mailer *RecordingMailer` to `Fixture`. In `NewFixtureWithWebhookSecret`, construct `mailer := &RecordingMailer{}` and call `api.NewServer(pool, cfg, api.Deps{Mailer: mailer})`. Create the admin user with `st.UpsertUserByEmail(ctx, "admin@example.com")` instead of `UpsertUserByGitHub`, then `st.LinkGitHub(ctx, user.ID, store.GitHubIdentity{ID: 1, Login: "sabari", Name: "Sabari"})` so evidence tests that match authors keep working. The membership insert keeps `invited_login` until Task 8 (`INSERT INTO membership (workspace_id, user_id, invited_login, role) VALUES ($1, $2, 'sabari', 'admin')`).

Add request helpers:

```go
// Request builds a request without a session. Serve runs it.
func (f *Fixture) Request(method, path string, body any) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		require.NoError(f.T, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func (f *Fixture) Serve(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// DoAnon is Do without the session cookie.
func (f *Fixture) DoAnon(method, path string, body any) *httptest.ResponseRecorder {
	return f.Serve(f.Request(method, path, body))
}
```

Refactor the existing `Do` to build on `Request` and add the cookie.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && go test ./internal/api/ -run TestEmailSignIn`
Expected: FAIL to compile (`api.Deps`, `DoAnon`).

- [ ] **Step 4: Implement**

`server.go`: add the `Deps` type, store it on `Server` as `mailer mail.Mailer` and `gh *github.Client`, change `NewServer(pool, cfg, deps Deps)`, and register `s.registerEmailAuthRoutes(mux)`. If `deps.Mailer` is nil, use `mail.NewLogMailer(slog.Default())`.

`api/internal/api/email_auth.go`:

```go
package api

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	mailer "github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerEmailAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/email", s.handleEmailStart)
	mux.HandleFunc("GET /api/v1/auth/magic", s.handleMagic)
}

// clientIP prefers the proxy header Caddy sets, falling back to the socket.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func validEmail(s string) (string, bool) {
	addr, err := mail.ParseAddress(strings.TrimSpace(s))
	if err != nil || addr.Name != "" || !strings.Contains(addr.Address, "@") {
		return "", false
	}
	return strings.ToLower(addr.Address), true
}

func (s *Server) magicLink(token string) string {
	return s.cfg.BaseURL + "/api/v1/auth/magic?token=" + url.QueryEscape(token)
}

func (s *Server) handleEmailStart(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if !DecodeJSON(w, r, &in) {
		return
	}
	email, ok := validEmail(in.Email)
	if !ok {
		WriteError(w, http.StatusBadRequest, "invalid_email", "enter a valid email address")
		return
	}
	token, err := s.store.IssueLoginToken(r.Context(), email, clientIP(r), nil)
	if errors.Is(err, store.ErrRateLimited) {
		WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many sign-in requests, try again later")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start sign-in")
		return
	}
	if err := s.mailer.Send(r.Context(), mailer.SignInMessage(email, s.magicLink(token))); err != nil {
		slog.Error("send sign-in mail", "err", err)
		WriteError(w, http.StatusBadGateway, "mail_failed", "could not send the sign-in mail")
		return
	}
	// The same answer for known and unknown addresses.
	WriteJSON(w, http.StatusAccepted, map[string]string{"status": "sent"})
}

func (s *Server) handleMagic(w http.ResponseWriter, r *http.Request) {
	lt, err := s.store.ConsumeLoginToken(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		http.Redirect(w, r, "/expired", http.StatusFound)
		return
	}
	user, err := s.store.UpsertUserByEmail(r.Context(), lt.Email)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not record the account")
		return
	}
	next := "/"
	if lt.InviteID != nil {
		// Task 7 replaces this with acceptance of the invite.
		next = "/"
	}
	token, err := s.store.CreateSession(r.Context(), user.ID, auth.SessionTTL)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create a session")
		return
	}
	auth.SetSessionCookie(w, token, s.secureCookies())
	http.Redirect(w, r, next, http.StatusFound)
}
```

In `auth.go` remove `handleLogin` and its `GET /api/v1/auth/github/login` registration, and remove the GitHub callback's session creation for now by deleting `handleCallback` and its registration (Task 9 brings the callback back as the link callback). Keep `handleLogout` and `handleMe`. Delete the `/not-invited` redirect with it.

`cmd/ticket/main.go`, in the `serve` branch:

```go
	var mailer mail.Mailer = mail.NewLogMailer(slog.Default())
	if cfg.ResendAPIKey != "" {
		mailer = mail.NewResend(cfg.ResendAPIKey, cfg.MailFrom, nil, "")
	} else {
		slog.Warn("RESEND_API_KEY not set: sign-in links are written to the log, not sent")
	}
	srv := api.NewServer(pool, cfg, api.Deps{Mailer: mailer})
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd api && go build ./... && go test ./internal/api/ ./internal/testutil/`
Expected: PASS for the new tests. `auth_test.go` tests that referenced the GitHub login route fail to compile or fail: delete those specific tests (`TestLoginRedirectsToGitHub` or similar) and keep the session tests.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "Sign in with an emailed magic link instead of GitHub"
```

---

### Task 6: Organisations: create, delete, leave, members

**Files:**
- Create: `api/internal/store/workspace.go`, `api/internal/api/org.go`
- Modify: `api/internal/api/server.go`, `api/internal/api/membership.go`
- Test: `api/internal/store/workspace_test.go`, `api/internal/api/org_test.go`

**Interfaces:**
- Produces:
  ```go
  type Workspace struct{ ID uuid.UUID; Name, Slug, IssuePrefix string }
  var ErrInvalidSlug, ErrInvalidPrefix error
  func ValidateSlug(slug string) error        // pattern and reserved list
  func ValidatePrefix(prefix string) error
  func (s *Store) CreateWorkspace(ctx, name, slug, prefix string, creatorID uuid.UUID) (Workspace, error)  // ErrDuplicate on slug
  func (s *Store) DeleteWorkspace(ctx, workspaceID uuid.UUID) error
  func (s *Store) LeaveWorkspace(ctx, workspaceID, userID uuid.UUID) error   // ErrLastAdmin
  func (s *Store) RemoveMember(ctx, workspaceID, membershipID, actorID uuid.UUID) error  // ErrLastAdmin, ErrForbidden removing self
  ```
  Endpoints: `POST /api/v1/orgs` body `{name, slug, issue_prefix}` → 201 `Membership`; `DELETE /api/v1/w/{slug}` body `{confirm}` must equal slug, admin → 204; `POST /api/v1/w/{slug}/leave` → 204; `DELETE /api/v1/w/{slug}/memberships/{id}` admin → 204. Existing `PATCH .../memberships/{id}` stays.

- [ ] **Step 1: Write the failing store tests**

`api/internal/store/workspace_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestValidateSlug(t *testing.T) {
	for _, ok := range []string{"velvet", "a-b", "abc", "x1-y2-z3"} {
		require.NoError(t, store.ValidateSlug(ok), ok)
	}
	for _, bad := range []string{"ab", "-abc", "abc-", "Ab", "a_b", "admin", "api", "w", "signin", "this-slug-is-far-too-long-to-be-allowed-here"} {
		require.ErrorIs(t, store.ValidateSlug(bad), store.ErrInvalidSlug, bad)
	}
	require.NoError(t, store.ValidatePrefix("VEL"))
	require.ErrorIs(t, store.ValidatePrefix("vel"), store.ErrInvalidPrefix)
	require.ErrorIs(t, store.ValidatePrefix("V"), store.ErrInvalidPrefix)
}

func TestCreateWorkspaceMakesCreatorAdmin(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "a@example.com")
	ws, err := st.CreateWorkspace(ctx, "Velvet", "velvet", "VEL", u.ID)
	require.NoError(t, err)
	ms, err := st.MembershipsForUser(ctx, u.ID)
	require.NoError(t, err)
	require.Len(t, ms, 1)
	require.Equal(t, "admin", ms[0].Role)
	require.Equal(t, ws.ID, ms[0].WorkspaceID)

	_, err = st.CreateWorkspace(ctx, "Other", "velvet", "OTH", u.ID)
	require.ErrorIs(t, err, store.ErrDuplicate)
}

func TestLeaveAndRemoveGuardLastAdmin(t *testing.T) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	a, _ := st.UpsertUserByEmail(ctx, "a@example.com")
	b, _ := st.UpsertUserByEmail(ctx, "b@example.com")
	ws, _ := st.CreateWorkspace(ctx, "Velvet", "velvet", "VEL", a.ID)
	mb, err := st.AddMember(ctx, ws.ID, b.ID, "member")
	require.NoError(t, err)

	require.ErrorIs(t, st.LeaveWorkspace(ctx, ws.ID, a.ID), store.ErrLastAdmin)
	require.NoError(t, st.LeaveWorkspace(ctx, ws.ID, b.ID))

	mb, err = st.AddMember(ctx, ws.ID, b.ID, "admin")
	require.NoError(t, err)
	require.NoError(t, st.LeaveWorkspace(ctx, ws.ID, a.ID), "another admin remains")
	require.ErrorIs(t, st.RemoveMember(ctx, ws.ID, mb.ID, b.ID), store.ErrForbidden, "cannot remove self")
}

func TestDeleteWorkspaceCascades(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()
	a, _ := st.UpsertUserByEmail(ctx, "a@example.com")
	ws, _ := st.CreateWorkspace(ctx, "Velvet", "velvet", "VEL", a.ID)
	require.NoError(t, st.DeleteWorkspace(ctx, ws.ID))
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM membership WHERE workspace_id = $1`, ws.ID).Scan(&n))
	require.Zero(t, n)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/store/ -run 'TestValidateSlug|Workspace|LastAdmin'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the store**

`api/internal/store/workspace.go`:

```go
package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidSlug   = errors.New("invalid slug")
	ErrInvalidPrefix = errors.New("invalid issue prefix")
)

var (
	slugRe   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`)
	prefixRe = regexp.MustCompile(`^[A-Z]{2,6}$`)
	// Route words a slug must not shadow.
	reservedSlugs = map[string]bool{
		"admin": true, "api": true, "auth": true, "check-email": true, "expired": true,
		"invite": true, "invites": true, "me": true, "new": true, "orgs": true,
		"settings": true, "signin": true, "signout": true, "w": true, "webhooks": true,
	}
)

type Workspace struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	IssuePrefix string    `json:"issue_prefix"`
}

func ValidateSlug(slug string) error {
	if !slugRe.MatchString(slug) || reservedSlugs[slug] {
		return ErrInvalidSlug
	}
	return nil
}

func ValidatePrefix(prefix string) error {
	if !prefixRe.MatchString(prefix) {
		return ErrInvalidPrefix
	}
	return nil
}

// CreateWorkspace creates an organisation and its first admin in one
// transaction, so a failure leaves neither behind.
func (s *Store) CreateWorkspace(ctx context.Context, name, slug, prefix string, creatorID uuid.UUID) (Workspace, error) {
	if name == "" {
		return Workspace{}, fmt.Errorf("%w: name is required", ErrInvalidSlug)
	}
	if err := ValidateSlug(slug); err != nil {
		return Workspace{}, err
	}
	if err := ValidatePrefix(prefix); err != nil {
		return Workspace{}, err
	}
	var ws Workspace
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO workspace (name, slug, issue_prefix) VALUES ($1, $2, $3)
			RETURNING id, name, slug, issue_prefix`, name, slug, prefix).
			Scan(&ws.ID, &ws.Name, &ws.Slug, &ws.IssuePrefix)
		if err != nil {
			return mapErr(err)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, ws.ID, creatorID)
		return mapErr(err)
	})
	return ws, err
}

// AddMember creates a membership for an existing user. Used by invite
// acceptance and tests.
func (s *Store) AddMember(ctx context.Context, workspaceID, userID uuid.UUID, role string) (Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, $3::membership_role)
			ON CONFLICT (workspace_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = membership.role
			RETURNING id, workspace_id, role
		)
		SELECT ins.id, ins.workspace_id, w.slug, w.name, ins.role::text
		FROM ins JOIN workspace w ON w.id = ins.workspace_id`, workspaceID, userID, role).
		Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	return m, mapErr(err)
}

func (s *Store) DeleteWorkspace(ctx context.Context, workspaceID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, workspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// adminCount is read FOR UPDATE inside a transaction so two concurrent
// leaves cannot both see "another admin remains".
func adminCount(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM membership WHERE workspace_id = $1 AND role = 'admin' FOR UPDATE`, workspaceID).Scan(&n)
	return n, err
}

func (s *Store) LeaveWorkspace(ctx context.Context, workspaceID, userID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx, `
			SELECT role::text FROM membership WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
			workspaceID, userID).Scan(&role)
		if err != nil {
			return mapErr(err)
		}
		if role == "admin" {
			n, err := adminCount(ctx, tx, workspaceID)
			if err != nil {
				return err
			}
			if n <= 1 {
				return ErrLastAdmin
			}
		}
		_, err = tx.Exec(ctx, `DELETE FROM membership WHERE workspace_id = $1 AND user_id = $2`, workspaceID, userID)
		return err
	})
}

func (s *Store) RemoveMember(ctx context.Context, workspaceID, membershipID, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var userID uuid.UUID
		var role string
		err := tx.QueryRow(ctx, `
			SELECT user_id, role::text FROM membership WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
			workspaceID, membershipID).Scan(&userID, &role)
		if err != nil {
			return mapErr(err)
		}
		if userID == actorID {
			return ErrForbidden
		}
		if role == "admin" {
			n, err := adminCount(ctx, tx, workspaceID)
			if err != nil {
				return err
			}
			if n <= 1 {
				return ErrLastAdmin
			}
		}
		_, err = tx.Exec(ctx, `DELETE FROM membership WHERE id = $1`, membershipID)
		return err
	})
}
```

Note: the partial unique index `(workspace_id, user_id) WHERE user_id IS NOT NULL` from 0001 is what `ON CONFLICT` targets until Task 8 replaces it with a plain unique constraint; after Task 8 change the clause to `ON CONFLICT (workspace_id, user_id)`.

- [ ] **Step 4: Run the store tests**

Run: `cd api && go test ./internal/store/`
Expected: PASS.

- [ ] **Step 5: Write the failing API tests**

`api/internal/api/org_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestCreateOrganisation(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Velvet", "slug": "velvet", "issue_prefix": "VEL"})
	require.Equal(t, http.StatusCreated, rec.Code)
	var m store.Membership
	f.DecodeInto(rec, &m)
	require.Equal(t, "velvet", m.Slug)
	require.Equal(t, "admin", m.Role)

	rec = f.Do(http.MethodPost, "/api/v1/orgs", map[string]string{"name": "X", "slug": "admin", "issue_prefix": "XX"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid_slug")

	rec = f.Do(http.MethodPost, "/api/v1/orgs", map[string]string{"name": "X", "slug": "velvet", "issue_prefix": "XX"})
	require.Equal(t, http.StatusConflict, rec.Code)

	rec = f.DoAnon(http.MethodPost, "/api/v1/orgs", map[string]string{"name": "X", "slug": "anon", "issue_prefix": "XX"})
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestDeleteOrganisationNeedsConfirmation(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodDelete, "/api/v1/w/lab", map[string]string{"confirm": "wrong"})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec = f.Do(http.MethodDelete, "/api/v1/w/lab", map[string]string{"confirm": "lab"})
	require.Equal(t, http.StatusNoContent, rec.Code)
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/members", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestLeaveAndRemoveMember(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/leave", nil)
	require.Equal(t, http.StatusConflict, rec.Code, "last admin cannot leave")

	other, err := f.Store.UpsertUserByEmail(f.Ctx(), "o@example.com")
	require.NoError(t, err)
	m, err := f.Store.AddMember(f.Ctx(), f.WorkspaceID, other.ID, "member")
	require.NoError(t, err)
	rec = f.Do(http.MethodDelete, "/api/v1/w/lab/memberships/"+m.ID.String(), nil)
	require.Equal(t, http.StatusNoContent, rec.Code)
}
```

Add `func (f *Fixture) Ctx() context.Context { return context.Background() }` to the fixture.

- [ ] **Step 6: Implement the API**

`api/internal/api/org.go`:

```go
package api

import (
	"errors"
	"net/http"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerOrgRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/orgs", s.RequireAuth(http.HandlerFunc(s.handleCreateOrg)))
	mux.Handle("DELETE /api/v1/w/{slug}", s.RequireAuth(s.RequireWorkspace(RequireRole("admin")(http.HandlerFunc(s.handleDeleteOrg)))))
	mux.Handle("POST /api/v1/w/{slug}/leave", s.RequireAuth(s.RequireWorkspace(http.HandlerFunc(s.handleLeaveOrg))))
	mux.Handle("DELETE /api/v1/w/{slug}/memberships/{id}", s.RequireAuth(s.RequireWorkspace(RequireRole("admin")(http.HandlerFunc(s.handleRemoveMember)))))
}

func (s *Server) handleCreateOrg(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	var in struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		IssuePrefix string `json:"issue_prefix"`
	}
	if !DecodeJSON(w, r, &in) {
		return
	}
	ws, err := s.store.CreateWorkspace(r.Context(), in.Name, in.Slug, in.IssuePrefix, user.ID)
	switch {
	case errors.Is(err, store.ErrInvalidSlug):
		WriteError(w, http.StatusBadRequest, "invalid_slug", "slug must be 3-40 lowercase letters, digits, or hyphens, and not a reserved word")
		return
	case errors.Is(err, store.ErrInvalidPrefix):
		WriteError(w, http.StatusBadRequest, "invalid_prefix", "issue prefix must be 2-6 uppercase letters")
		return
	case errors.Is(err, store.ErrDuplicate):
		WriteError(w, http.StatusConflict, "slug_taken", "that slug is already in use")
		return
	case err != nil:
		WriteError(w, http.StatusInternalServerError, "internal", "could not create the organisation")
		return
	}
	m, err := s.store.MembershipForSlug(r.Context(), user.ID, ws.Slug)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the membership")
		return
	}
	WriteJSON(w, http.StatusCreated, m)
}

func (s *Server) handleDeleteOrg(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	var in struct {
		Confirm string `json:"confirm"`
	}
	if !DecodeJSON(w, r, &in) {
		return
	}
	if in.Confirm != ws.Slug {
		WriteError(w, http.StatusBadRequest, "confirm_mismatch", "type the organisation slug to confirm")
		return
	}
	if err := s.store.DeleteWorkspace(r.Context(), ws.WorkspaceID); err != nil {
		writeStoreError(w, err, "organisation")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLeaveOrg(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	ws, _ := CurrentWorkspace(r.Context())
	err := s.store.LeaveWorkspace(r.Context(), ws.WorkspaceID, user.ID)
	if errors.Is(err, store.ErrLastAdmin) {
		WriteError(w, http.StatusConflict, "last_admin", "promote another admin before leaving")
		return
	}
	if err != nil {
		writeStoreError(w, err, "membership")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	err := s.store.RemoveMember(r.Context(), ws.WorkspaceID, id, user.ID)
	switch {
	case errors.Is(err, store.ErrLastAdmin):
		WriteError(w, http.StatusConflict, "last_admin", "the organisation needs at least one admin")
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, http.StatusBadRequest, "self_removal", "use leave to remove yourself")
	case err != nil:
		writeStoreError(w, err, "membership")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
```

Register `s.registerOrgRoutes(mux)` in `server.go`. In `RequireWorkspace`, a membership lookup that returns `ErrNotFound` must answer 404 with code `not_found` (check the existing behaviour and keep it).

- [ ] **Step 7: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run 'Organisation|LeaveAndRemove'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api
git commit -m "Create, delete, and leave organisations, and remove members"
```

---

### Task 7: Invitations

**Files:**
- Create: `api/internal/store/invite.go`, `api/internal/api/invite.go`
- Modify: `api/internal/api/email_auth.go` (invite-tied magic links), `api/internal/api/server.go`
- Test: `api/internal/store/invite_test.go`, `api/internal/api/invite_test.go`

**Interfaces:**
- Consumes: `store.IssueLoginToken(ctx, email, ip, inviteID)`, `store.ConsumeLoginToken` returning `InviteID`, `store.AddMember`, `mail.InviteMessage`.
- Produces:
  ```go
  type Invite struct{ ID, WorkspaceID uuid.UUID; Email, Role string; InvitedBy uuid.UUID; ExpiresAt time.Time; AcceptedAt, RevokedAt *time.Time }
  type InvitePreview struct{ ID uuid.UUID; Email, Role, OrgName, OrgSlug, InviterName string }
  const InviteTTL = 7 * 24 * time.Hour
  func (s *Store) CreateInvite(ctx, workspaceID, invitedBy uuid.UUID, email, role string) (Invite, token string, err error)  // replaces a pending one
  func (s *Store) ListInvites(ctx, workspaceID uuid.UUID) ([]Invite, error)   // pending only
  func (s *Store) RevokeInvite(ctx, workspaceID, inviteID uuid.UUID) error
  func (s *Store) RotateInviteToken(ctx, workspaceID, inviteID uuid.UUID) (Invite, string, error)  // resend
  func (s *Store) InviteByToken(ctx, token string) (InvitePreview, error)     // ErrNotFound when dead
  func (s *Store) InviteByID(ctx, id uuid.UUID) (InvitePreview, error)
  func (s *Store) AcceptInvite(ctx, inviteID, userID uuid.UUID) (Membership, error)  // ErrForbidden when emails differ, ErrNotFound when dead
  ```
  Endpoints: `GET|POST /api/v1/w/{slug}/invites` (admin), `POST .../invites/{id}/resend`, `DELETE .../invites/{id}`, `GET /api/v1/invite/{token}` (anonymous, returns `InvitePreview` plus `{"signed_in": bool, "email_matches": bool}`), `POST /api/v1/invite/{token}/accept` (signed in → 200 `Membership`; signed out → issues an invite-tied login token, mails it, 202 `{"status":"sent"}`).

- [ ] **Step 1: Write the failing store tests**

`api/internal/store/invite_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func setupOrg(t *testing.T) (*store.Store, store.User, store.Workspace) {
	st := store.New(testutil.NewPostgres(t))
	ctx := context.Background()
	admin, err := st.UpsertUserByEmail(ctx, "admin@example.com")
	require.NoError(t, err)
	ws, err := st.CreateWorkspace(ctx, "Velvet", "velvet", "VEL", admin.ID)
	require.NoError(t, err)
	return st, admin, ws
}

func TestInviteLifecycle(t *testing.T) {
	st, admin, ws := setupOrg(t)
	ctx := context.Background()

	inv, token, err := st.CreateInvite(ctx, ws.ID, admin.ID, "New@Example.com", "member")
	require.NoError(t, err)
	require.Equal(t, "new@example.com", inv.Email)
	require.NotEmpty(t, token)

	p, err := st.InviteByToken(ctx, token)
	require.NoError(t, err)
	require.Equal(t, "Velvet", p.OrgName)
	require.Equal(t, "member", p.Role)

	// Re-inviting replaces the pending invite and its token.
	_, token2, err := st.CreateInvite(ctx, ws.ID, admin.ID, "new@example.com", "viewer")
	require.NoError(t, err)
	_, err = st.InviteByToken(ctx, token)
	require.ErrorIs(t, err, store.ErrNotFound, "old token is dead")
	p, err = st.InviteByToken(ctx, token2)
	require.NoError(t, err)
	require.Equal(t, "viewer", p.Role)

	list, err := st.ListInvites(ctx, ws.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)

	u, _ := st.UpsertUserByEmail(ctx, "new@example.com")
	m, err := st.AcceptInvite(ctx, p.ID, u.ID)
	require.NoError(t, err)
	require.Equal(t, "viewer", m.Role)
	require.Equal(t, "velvet", m.Slug)

	_, err = st.AcceptInvite(ctx, p.ID, u.ID)
	require.ErrorIs(t, err, store.ErrNotFound, "accepted once")
	list, _ = st.ListInvites(ctx, ws.ID)
	require.Empty(t, list)
}

func TestInviteRefusesOtherEmail(t *testing.T) {
	st, admin, ws := setupOrg(t)
	ctx := context.Background()
	_, token, _ := st.CreateInvite(ctx, ws.ID, admin.ID, "new@example.com", "member")
	p, _ := st.InviteByToken(ctx, token)
	other, _ := st.UpsertUserByEmail(ctx, "other@example.com")
	_, err := st.AcceptInvite(ctx, p.ID, other.ID)
	require.ErrorIs(t, err, store.ErrForbidden)
}

func TestInviteRevokeAndExpiry(t *testing.T) {
	st, admin, ws := setupOrg(t)
	ctx := context.Background()
	inv, token, _ := st.CreateInvite(ctx, ws.ID, admin.ID, "a@example.com", "member")
	require.NoError(t, st.RevokeInvite(ctx, ws.ID, inv.ID))
	_, err := st.InviteByToken(ctx, token)
	require.ErrorIs(t, err, store.ErrNotFound)

	inv2, token2, _ := st.CreateInvite(ctx, ws.ID, admin.ID, "b@example.com", "member")
	_, err = st.Pool().Exec(ctx, `UPDATE invite SET expires_at = now() - interval '1 hour' WHERE id = $1`, inv2.ID)
	require.NoError(t, err)
	_, err = st.InviteByToken(ctx, token2)
	require.ErrorIs(t, err, store.ErrNotFound)

	_, token3, err := st.RotateInviteToken(ctx, ws.ID, inv2.ID)
	require.NoError(t, err, "resend revives an expired invite with a new token")
	_, err = st.InviteByToken(ctx, token3)
	require.NoError(t, err)
}

func TestInviteIsScopedToWorkspace(t *testing.T) {
	st, admin, ws := setupOrg(t)
	ctx := context.Background()
	other, _ := st.UpsertUserByEmail(ctx, "x@example.com")
	ws2, _ := st.CreateWorkspace(ctx, "Other", "other", "OTH", other.ID)
	inv, _, _ := st.CreateInvite(ctx, ws.ID, admin.ID, "a@example.com", "member")
	require.ErrorIs(t, st.RevokeInvite(ctx, ws2.ID, inv.ID), store.ErrNotFound, "another org cannot revoke it")
	list, _ := st.ListInvites(ctx, ws2.ID)
	require.Empty(t, list)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/store/ -run Invite`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the store**

`api/internal/store/invite.go`:

```go
package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const InviteTTL = 7 * 24 * time.Hour

type Invite struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	Email       string     `json:"email"`
	Role        string     `json:"role"`
	InvitedBy   uuid.UUID  `json:"invited_by"`
	ExpiresAt   time.Time  `json:"expires_at"`
	AcceptedAt  *time.Time `json:"accepted_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
}

// InvitePreview is what the accept page shows before anyone is signed in.
type InvitePreview struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	OrgName     string    `json:"org_name"`
	OrgSlug     string    `json:"org_slug"`
	InviterName string    `json:"inviter_name"`
}

const inviteCols = `i.id, i.workspace_id, i.email, i.role::text, i.invited_by, i.expires_at, i.accepted_at, i.revoked_at`

func scanInvite(row pgx.Row) (Invite, error) {
	var i Invite
	err := row.Scan(&i.ID, &i.WorkspaceID, &i.Email, &i.Role, &i.InvitedBy, &i.ExpiresAt, &i.AcceptedAt, &i.RevokedAt)
	return i, mapErr(err)
}

// CreateInvite issues an invite, revoking any pending one for the same
// address first so the unique index never fires and the old link dies.
func (s *Store) CreateInvite(ctx context.Context, workspaceID, invitedBy uuid.UUID, email, role string) (Invite, string, error) {
	email = normalizeEmail(email)
	token, err := NewToken()
	if err != nil {
		return Invite{}, "", err
	}
	var inv Invite
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE invite SET revoked_at = now()
			WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
			workspaceID, email); err != nil {
			return err
		}
		var err error
		inv, err = scanInvite(tx.QueryRow(ctx, `
			INSERT INTO invite AS i (workspace_id, email, role, token_hash, invited_by, expires_at)
			VALUES ($1, $2, $3::membership_role, $4, $5, now() + $6::interval)
			RETURNING `+inviteCols,
			workspaceID, email, role, HashToken(token), invitedBy, InviteTTL.String()))
		return err
	})
	return inv, token, err
}

func (s *Store) ListInvites(ctx context.Context, workspaceID uuid.UUID) ([]Invite, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+inviteCols+` FROM invite i
		WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		ORDER BY i.created_at`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		i, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) RevokeInvite(ctx context.Context, workspaceID, inviteID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE invite SET revoked_at = now()
		WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, inviteID, workspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RotateInviteToken is "resend": a fresh token and a fresh expiry.
func (s *Store) RotateInviteToken(ctx context.Context, workspaceID, inviteID uuid.UUID) (Invite, string, error) {
	token, err := NewToken()
	if err != nil {
		return Invite{}, "", err
	}
	inv, err := scanInvite(s.pool.QueryRow(ctx, `
		UPDATE invite AS i SET token_hash = $3, expires_at = now() + $4::interval
		WHERE i.id = $1 AND i.workspace_id = $2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		RETURNING `+inviteCols, inviteID, workspaceID, HashToken(token), InviteTTL.String()))
	return inv, token, err
}

const previewSQL = `
	SELECT i.id, i.email, i.role::text, w.name, w.slug, COALESCE(NULLIF(u.name, ''), u.email)
	FROM invite i
	JOIN workspace w ON w.id = i.workspace_id
	JOIN app_user u ON u.id = i.invited_by
	WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND `

func scanPreview(row pgx.Row) (InvitePreview, error) {
	var p InvitePreview
	err := row.Scan(&p.ID, &p.Email, &p.Role, &p.OrgName, &p.OrgSlug, &p.InviterName)
	return p, mapErr(err)
}

func (s *Store) InviteByToken(ctx context.Context, token string) (InvitePreview, error) {
	return scanPreview(s.pool.QueryRow(ctx, previewSQL+`i.token_hash = $1`, HashToken(token)))
}

func (s *Store) InviteByID(ctx context.Context, id uuid.UUID) (InvitePreview, error) {
	return scanPreview(s.pool.QueryRow(ctx, previewSQL+`i.id = $1`, id))
}

// AcceptInvite turns a live invite into a membership for the user whose
// email it was sent to. ErrForbidden for anyone else.
func (s *Store) AcceptInvite(ctx context.Context, inviteID, userID uuid.UUID) (Membership, error) {
	var m Membership
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var wsID uuid.UUID
		var email, role string
		err := tx.QueryRow(ctx, `
			SELECT workspace_id, email, role::text FROM invite
			WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
			FOR UPDATE`, inviteID).Scan(&wsID, &email, &role)
		if err != nil {
			return mapErr(err)
		}
		var userEmail string
		if err := tx.QueryRow(ctx, `SELECT email FROM app_user WHERE id = $1`, userID).Scan(&userEmail); err != nil {
			return mapErr(err)
		}
		if normalizeEmail(userEmail) != normalizeEmail(email) {
			return ErrForbidden
		}
		if _, err := tx.Exec(ctx, `UPDATE invite SET accepted_at = now() WHERE id = $1`, inviteID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			WITH ins AS (
				INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, $3::membership_role)
				ON CONFLICT (workspace_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = membership.role
				RETURNING id, workspace_id, role
			)
			SELECT ins.id, ins.workspace_id, w.slug, w.name, ins.role::text
			FROM ins JOIN workspace w ON w.id = ins.workspace_id`, wsID, userID, role).
			Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	})
	return m, err
}
```

- [ ] **Step 4: Run the store tests**

Run: `cd api && go test ./internal/store/`
Expected: PASS.

- [ ] **Step 5: Write the failing API tests**

`api/internal/api/invite_test.go`:

```go
package api_test

import (
	"net/http"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

var inviteLinkRe = regexp.MustCompile(`/invite/([A-Za-z0-9_-]+)`)

func TestInviteFlowSignedOut(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/invites", map[string]string{"email": "colleague@example.com", "role": "member"})
	require.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, f.Mailer.Sent, 1)
	link := inviteLinkRe.FindStringSubmatch(f.Mailer.Sent[0].Text)
	require.NotNil(t, link)
	token := link[1]

	// Anonymous preview.
	rec = f.DoAnon(http.MethodGet, "/api/v1/invite/"+token, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"org_name":"Lab"`)
	require.Contains(t, rec.Body.String(), `"signed_in":false`)

	// Accepting signed out mails a magic link tied to the invite.
	rec = f.DoAnon(http.MethodPost, "/api/v1/invite/"+token+"/accept", nil)
	require.Equal(t, http.StatusAccepted, rec.Code)
	require.Len(t, f.Mailer.Sent, 2)
	magic := magicLinkRe.FindStringSubmatch(f.Mailer.Sent[1].Text)
	require.NotNil(t, magic)

	// The magic link signs in and joins in one step.
	rec = f.DoAnon(http.MethodGet, "/api/v1/auth/magic?token="+magic[1], nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Equal(t, "/w/lab", rec.Header().Get("Location"))
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "ticket_session" {
			cookie = c
		}
	}
	require.NotNil(t, cookie)
	req := f.Request(http.MethodGet, "/api/v1/w/lab/members", nil)
	req.AddCookie(cookie)
	rec = f.Serve(req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "colleague@example.com")

	// Invite is no longer pending.
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/invites", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "[]\n", rec.Body.String())
}

func TestInviteFlowSignedInWrongEmail(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/invites", map[string]string{"email": "someone@example.com", "role": "member"})
	require.Equal(t, http.StatusCreated, rec.Code)
	token := inviteLinkRe.FindStringSubmatch(f.Mailer.Sent[0].Text)[1]

	rec = f.Do(http.MethodGet, "/api/v1/invite/"+token, nil)
	require.Contains(t, rec.Body.String(), `"email_matches":false`)
	rec = f.Do(http.MethodPost, "/api/v1/invite/"+token+"/accept", nil)
	require.Equal(t, http.StatusForbidden, rec.Code)
}

func TestInviteResendRevokeAndRoles(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/invites", map[string]string{"email": "a@example.com", "role": "owner"})
	require.Equal(t, http.StatusBadRequest, rec.Code, "unknown role")

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/invites", map[string]string{"email": "a@example.com", "role": "viewer"})
	require.Equal(t, http.StatusCreated, rec.Code)
	var inv store.Invite
	f.DecodeInto(rec, &inv)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/invites/"+inv.ID.String()+"/resend", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, f.Mailer.Sent, 2)

	rec = f.Do(http.MethodDelete, "/api/v1/w/lab/invites/"+inv.ID.String(), nil)
	require.Equal(t, http.StatusNoContent, rec.Code)
	old := inviteLinkRe.FindStringSubmatch(f.Mailer.Sent[1].Text)[1]
	rec = f.DoAnon(http.MethodGet, "/api/v1/invite/"+old, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)

	// Members cannot invite.
	member, _ := f.Store.UpsertUserByEmail(f.Ctx(), "m@example.com")
	_, err := f.Store.AddMember(f.Ctx(), f.WorkspaceID, member.ID, "member")
	require.NoError(t, err)
	tok, _ := f.Store.CreateSession(f.Ctx(), member.ID, time.Hour)
	req := f.Request(http.MethodPost, "/api/v1/w/lab/invites", map[string]string{"email": "z@example.com", "role": "member"})
	req.AddCookie(&http.Cookie{Name: "ticket_session", Value: tok})
	require.Equal(t, http.StatusForbidden, f.Serve(req).Code)
}
```

Add `"time"` to the imports.

- [ ] **Step 6: Implement the API**

`api/internal/api/invite.go`:

```go
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	mailer "github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerInviteRoutes(mux *http.ServeMux) {
	admin := func(h http.HandlerFunc) http.Handler {
		return s.RequireAuth(s.RequireWorkspace(RequireRole("admin")(h)))
	}
	mux.Handle("GET /api/v1/w/{slug}/invites", admin(s.handleListInvites))
	mux.Handle("POST /api/v1/w/{slug}/invites", admin(s.handleCreateInvite))
	mux.Handle("POST /api/v1/w/{slug}/invites/{id}/resend", admin(s.handleResendInvite))
	mux.Handle("DELETE /api/v1/w/{slug}/invites/{id}", admin(s.handleRevokeInvite))
	// Anonymous: the accept page must work before sign-in.
	mux.HandleFunc("GET /api/v1/invite/{token}", s.handleInvitePreview)
	mux.HandleFunc("POST /api/v1/invite/{token}/accept", s.handleAcceptInvite)
}

func (s *Server) inviteLink(token string) string {
	return s.cfg.BaseURL + "/invite/" + url.PathEscape(token)
}

func (s *Server) sendInvite(r *http.Request, inv store.Invite, token string) bool {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	inviter := user.Name
	if inviter == "" {
		inviter = user.Email
	}
	if err := s.mailer.Send(r.Context(), mailer.InviteMessage(inv.Email, ws.Name, inviter, s.inviteLink(token))); err != nil {
		slog.Error("send invite", "err", err)
		return false
	}
	return true
}

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	list, err := s.store.ListInvites(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list invites")
		return
	}
	if list == nil {
		list = []store.Invite{}
	}
	WriteJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !DecodeJSON(w, r, &in) {
		return
	}
	email, ok := validEmail(in.Email)
	if !ok {
		WriteError(w, http.StatusBadRequest, "invalid_email", "enter a valid email address")
		return
	}
	if !validMembershipRole(in.Role) {
		WriteError(w, http.StatusBadRequest, "invalid_role", "role must be admin, member, or viewer")
		return
	}
	inv, token, err := s.store.CreateInvite(r.Context(), ws.WorkspaceID, user.ID, email, in.Role)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create the invite")
		return
	}
	if !s.sendInvite(r, inv, token) {
		WriteError(w, http.StatusBadGateway, "mail_failed", "the invite was created but the mail could not be sent; use resend")
		return
	}
	WriteJSON(w, http.StatusCreated, inv)
}

func (s *Server) handleResendInvite(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	inv, token, err := s.store.RotateInviteToken(r.Context(), ws.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, err, "invite")
		return
	}
	if !s.sendInvite(r, inv, token) {
		WriteError(w, http.StatusBadGateway, "mail_failed", "could not send the invite")
		return
	}
	WriteJSON(w, http.StatusOK, inv)
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.RevokeInvite(r.Context(), ws.WorkspaceID, id); err != nil {
		writeStoreError(w, err, "invite")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// optionalUser resolves the session if there is one, without failing.
func (s *Server) optionalUser(r *http.Request) (store.User, bool) {
	c, err := r.Cookie(auth.CookieName)
	if err != nil {
		return store.User{}, false
	}
	u, err := s.store.UserBySessionToken(r.Context(), c.Value)
	return u, err == nil
}

func (s *Server) handleInvitePreview(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.InviteByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		writeStoreError(w, err, "invite")
		return
	}
	user, signedIn := s.optionalUser(r)
	WriteJSON(w, http.StatusOK, map[string]any{
		"invite":        p,
		"signed_in":     signedIn,
		"email_matches": signedIn && user.Email == p.Email,
	})
}

func (s *Server) handleAcceptInvite(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.InviteByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		writeStoreError(w, err, "invite")
		return
	}
	if user, ok := s.optionalUser(r); ok {
		m, err := s.store.AcceptInvite(r.Context(), p.ID, user.ID)
		if errors.Is(err, store.ErrForbidden) {
			WriteError(w, http.StatusForbidden, "email_mismatch", "this invitation was sent to "+p.Email)
			return
		}
		if err != nil {
			writeStoreError(w, err, "invite")
			return
		}
		WriteJSON(w, http.StatusOK, m)
		return
	}
	// Signed out: mail a magic link that both signs in and accepts.
	id := p.ID
	token, err := s.store.IssueLoginToken(r.Context(), p.Email, clientIP(r), &id)
	if errors.Is(err, store.ErrRateLimited) {
		WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many sign-in requests, try again later")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start sign-in")
		return
	}
	if err := s.mailer.Send(r.Context(), mailer.SignInMessage(p.Email, s.magicLink(token))); err != nil {
		WriteError(w, http.StatusBadGateway, "mail_failed", "could not send the sign-in mail")
		return
	}
	WriteJSON(w, http.StatusAccepted, map[string]string{"status": "sent", "email": p.Email})
}
```

In `email_auth.go` `handleMagic`, replace the placeholder branch:

```go
	next := "/"
	if lt.InviteID != nil {
		m, err := s.store.AcceptInvite(r.Context(), *lt.InviteID, user.ID)
		if err == nil {
			next = "/w/" + m.Slug
		}
		// A dead invite still signs the person in; they land on the
		// organisation page and see nothing pending.
	}
```

`validMembershipRole` already exists in `membership.go`; keep it there. Register `s.registerInviteRoutes(mux)` in `server.go`.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `cd api && go test ./internal/api/ -run Invite`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api
git commit -m "Invite people to an organisation by email"
```

---

### Task 8: Remove GitHub-login invites and tighten the schema

**Files:**
- Create: `api/internal/db/migrations/0006_email_identity.sql`
- Modify: `api/internal/store/user.go`, `api/internal/store/workspace.go`, `api/internal/store/invite.go`, `api/internal/api/membership.go`, `api/internal/testutil/fixtures.go`, `api/internal/api/membership_test.go`, `api/internal/api/security_test.go`
- Delete: `deploy/bootstrap.sh`, `deploy/invite.sh`
- Test: `api/internal/db/migrate_test.go`

**Interfaces:**
- Removes: `store.InviteWorkspaceMember`, `store.BindMembership`, `store.UpsertUserByGitHub`, `store.WorkspaceMembership.InvitedLogin`, `POST /api/v1/w/{slug}/memberships`.
- Produces: `store.WorkspaceMembership{ID, WorkspaceID, Role, User *User}` where `User` is never nil.

- [ ] **Step 1: Write the failing migration test**

Append to `migrate_test.go`:

```go
func TestMigrateEmailIdentityIsStrict(t *testing.T) {
	pool := testutil.NewPostgres(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO app_user (github_id, github_login) VALUES (5, 'x')`)
	require.Error(t, err, "email is required")
	var exists bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name = 'membership' AND column_name = 'invited_login')`).Scan(&exists))
	require.False(t, exists)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && go test ./internal/db/ -run TestMigrateEmailIdentityIsStrict`
Expected: FAIL, the insert succeeds.

- [ ] **Step 3: Remove the code that reads `invited_login`**

- `user.go`: delete `InviteWorkspaceMember`, `BindMembership`, `UpsertUserByGitHub`. Remove `InvitedLogin` from `WorkspaceMembership` and from the `ListWorkspaceMemberships` select; that query becomes an inner join on `app_user` since every membership has a user:
  ```go
  SELECT m.id, m.workspace_id, m.role::text, `+userCols+`
  FROM membership m JOIN app_user u ON u.id = m.user_id
  WHERE m.workspace_id = $1 ORDER BY u.email
  ```
- `membership.go`: delete `handleInviteMembership`, its route, and `githubLoginRe`. Keep `GET .../members`, `GET .../memberships`, `PATCH .../memberships/{id}`, and `validMembershipRole`.
- `workspace.go` and `invite.go`: change both `ON CONFLICT (workspace_id, user_id) WHERE user_id IS NOT NULL` to `ON CONFLICT (workspace_id, user_id)`.
- `fixtures.go`: the membership insert becomes `INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`.
- `membership_test.go`: delete the invite-by-login tests; keep the role-change tests, creating the second member with `f.Store.UpsertUserByEmail` and `f.Store.AddMember`.
- `security_test.go`: wherever a second workspace or user is seeded with `github_id`, seed with `UpsertUserByEmail` and `CreateWorkspace` instead.
- Delete `deploy/bootstrap.sh` and `deploy/invite.sh`.

- [ ] **Step 4: Write the migration**

`api/internal/db/migrations/0006_email_identity.sql`:

```sql
-- Refuse to proceed if any user still has no email. The operator sets it
-- by hand before deploying; inventing one would hide a real account.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM app_user WHERE email IS NULL) THEN
        RAISE EXCEPTION 'app_user rows without email exist; set them before migrating';
    END IF;
    IF EXISTS (SELECT 1 FROM membership WHERE user_id IS NULL) THEN
        RAISE EXCEPTION 'membership rows without a user exist (unclaimed invites); delete them before migrating';
    END IF;
END $$;

ALTER TABLE app_user ALTER COLUMN email SET NOT NULL;

ALTER TABLE membership ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_user_id_fkey;
ALTER TABLE membership ADD CONSTRAINT membership_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS membership_workspace_login_idx;
DROP INDEX IF EXISTS membership_user_idx;
ALTER TABLE membership DROP COLUMN invited_login;
ALTER TABLE membership ADD CONSTRAINT membership_workspace_user_key UNIQUE (workspace_id, user_id);
```

Check the exact constraint and index names against `0001_init.sql` and `0004_membership_login_index.sql` before committing; `\d membership` in psql against a migrated test database lists them.

- [ ] **Step 5: Run the whole Go suite**

Run: `cd api && go build ./... && go vet ./... && go test -count=1 ./...`
Expected: PASS. Fix any remaining reference to the removed functions.

- [ ] **Step 6: Commit**

```bash
git add -A api deploy
git commit -m "Drop invites by GitHub login: email is the identity now"
```

---

### Task 9: GitHub at organisation level: setup states, binding, repository sync

**Files:**
- Create: `api/internal/store/github_setup.go`, `api/internal/api/github_setup.go`
- Modify: `api/internal/github/client.go`, `api/internal/worker/installation.go`, `api/internal/store/pull_request.go`, `api/internal/api/github.go`, `api/internal/api/server.go`, `api/cmd/ticket/main.go`, `api/internal/testutil/fixtures.go`
- Delete: `deploy/connect-repo.sh`
- Test: `api/internal/store/github_setup_test.go`, `api/internal/api/github_setup_test.go`, `api/internal/worker/installation_test.go`

**Interfaces:**
- Produces, store:
  ```go
  const SetupStateTTL = 15 * time.Minute
  func (s *Store) IssueSetupState(ctx, workspaceID, userID uuid.UUID) (string, error)
  func (s *Store) ConsumeSetupState(ctx, token string, userID uuid.UUID) (workspaceID uuid.UUID, err error)  // ErrNotFound; ErrForbidden when another user
  func (s *Store) BindInstallation(ctx, installationID int64, accountLogin string, workspaceID uuid.UUID) error  // ErrForeignReference when bound elsewhere
  type InstallationRepo struct{ GitHubID int64; Owner, Name, DefaultBranch string }
  func (s *Store) SyncInstallationRepos(ctx, installationID int64, repos []InstallationRepo) error  // upsert listed, delete missing
  func (s *Store) RemoveInstallationRepos(ctx, installationID int64, githubIDs []int64) error
  func (s *Store) SetInstallationSuspended(ctx, installationID int64, suspended bool) error
  func (s *Store) InstallationForWorkspace(ctx, workspaceID uuid.UUID) (Installation, error)
  type Installation struct{ ID int64; AccountLogin string; WorkspaceID *uuid.UUID; SuspendedAt *time.Time }
  ```
- Produces, github client:
  ```go
  type InstallationInfo struct{ ID int64; AccountLogin string }
  func (c *Client) GetInstallation(ctx, id int64) (InstallationInfo, error)              // GET /app/installations/{id} with the App JWT
  func (c *Client) ListInstallationRepositories(ctx, id int64) ([]RepoInfo, error)     // GET /installation/repositories, paginated
  type RepoInfo struct{ ID int64; Owner, Name, DefaultBranch string }
  func (c *Client) GetRepository(ctx, installationID int64, owner, name string) (RepoInfo, error)
  ```
- Endpoints: `GET /api/v1/w/{slug}/github/connect` (admin) → 302 to `https://github.com/apps/{GITHUB_APP_SLUG}/installations/new?state=`; `GET /api/v1/github/setup?installation_id=&state=` (signed in) → 302 `/w/{slug}/admin`; `GET /api/v1/w/{slug}/github` → `{installation: Installation|null, repos: []Repo}`.
- Removed: `POST /api/v1/w/{slug}/repos`, `store.LinkRepo`.

- [ ] **Step 1: Write the failing store tests**

`api/internal/store/github_setup_test.go`:

```go
package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestSetupState(t *testing.T) {
	st, admin, ws := setupOrg(t)
	ctx := context.Background()
	other, _ := st.UpsertUserByEmail(ctx, "o@example.com")

	tok, err := st.IssueSetupState(ctx, ws.ID, admin.ID)
	require.NoError(t, err)
	_, err = st.ConsumeSetupState(ctx, tok, other.ID)
	require.ErrorIs(t, err, store.ErrForbidden, "someone else cannot use it")
	got, err := st.ConsumeSetupState(ctx, tok, admin.ID)
	require.NoError(t, err)
	require.Equal(t, ws.ID, got)
	_, err = st.ConsumeSetupState(ctx, tok, admin.ID)
	require.ErrorIs(t, err, store.ErrNotFound, "single use")
}

func TestBindInstallationAndSync(t *testing.T) {
	st, _, ws := setupOrg(t)
	ctx := context.Background()
	other, _ := st.UpsertUserByEmail(ctx, "o@example.com")
	ws2, _ := st.CreateWorkspace(ctx, "Other", "other", "OTH", other.ID)

	require.NoError(t, st.BindInstallation(ctx, 99, "acme", ws.ID))
	require.ErrorIs(t, st.BindInstallation(ctx, 99, "acme", ws2.ID), store.ErrForeignReference)
	require.NoError(t, st.BindInstallation(ctx, 99, "acme", ws.ID), "rebinding to the same org is idempotent")

	require.NoError(t, st.SyncInstallationRepos(ctx, 99, []store.InstallationRepo{
		{GitHubID: 1, Owner: "acme", Name: "a", DefaultBranch: "main"},
		{GitHubID: 2, Owner: "acme", Name: "b", DefaultBranch: "main"},
	}))
	repos, _ := st.ListRepos(ctx, ws.ID)
	require.Len(t, repos, 2)

	require.NoError(t, st.SyncInstallationRepos(ctx, 99, []store.InstallationRepo{
		{GitHubID: 2, Owner: "acme", Name: "b-renamed", DefaultBranch: "trunk"},
	}))
	repos, _ = st.ListRepos(ctx, ws.ID)
	require.Len(t, repos, 1)
	require.Equal(t, "b-renamed", repos[0].Name)

	require.NoError(t, st.RemoveInstallationRepos(ctx, 99, []int64{2}))
	repos, _ = st.ListRepos(ctx, ws.ID)
	require.Empty(t, repos)

	inst, err := st.InstallationForWorkspace(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, int64(99), inst.ID)
	require.Nil(t, inst.SuspendedAt)
	require.NoError(t, st.SetInstallationSuspended(ctx, 99, true))
	inst, _ = st.InstallationForWorkspace(ctx, ws.ID)
	require.NotNil(t, inst.SuspendedAt)
	_, err = st.InstallationForWorkspace(ctx, ws2.ID)
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestReposDueForSyncSkipsSuspended(t *testing.T) {
	st, _, ws := setupOrg(t)
	ctx := context.Background()
	require.NoError(t, st.BindInstallation(ctx, 99, "acme", ws.ID))
	require.NoError(t, st.SyncInstallationRepos(ctx, 99, []store.InstallationRepo{{GitHubID: 1, Owner: "acme", Name: "a", DefaultBranch: "main"}}))
	due, err := st.ReposDueForSync(ctx, 0)
	require.NoError(t, err)
	require.Len(t, due, 1)
	require.NoError(t, st.SetInstallationSuspended(ctx, 99, true))
	due, _ = st.ReposDueForSync(ctx, 0)
	require.Empty(t, due)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/store/ -run 'SetupState|BindInstallation|SkipsSuspended'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the store**

`api/internal/store/github_setup.go`:

```go
package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const SetupStateTTL = 15 * time.Minute

type Installation struct {
	ID           int64      `json:"id"`
	AccountLogin string     `json:"account_login"`
	WorkspaceID  *uuid.UUID `json:"workspace_id"`
	SuspendedAt  *time.Time `json:"suspended_at"`
}

type InstallationRepo struct {
	GitHubID      int64
	Owner         string
	Name          string
	DefaultBranch string
}

func (s *Store) IssueSetupState(ctx context.Context, workspaceID, userID uuid.UUID) (string, error) {
	token, err := NewToken()
	if err != nil {
		return "", err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO github_setup_state (token_hash, workspace_id, user_id, expires_at)
		VALUES ($1, $2, $3, now() + $4::interval)`, HashToken(token), workspaceID, userID, SetupStateTTL.String())
	return token, err
}

// ConsumeSetupState deletes the state and returns its organisation. The
// user must be the one who started the flow; a leaked URL is useless to
// anyone else.
func (s *Store) ConsumeSetupState(ctx context.Context, token string, userID uuid.UUID) (uuid.UUID, error) {
	var wsID, owner uuid.UUID
	err := s.pool.QueryRow(ctx, `
		DELETE FROM github_setup_state
		WHERE token_hash = $1 AND expires_at > now()
		RETURNING workspace_id, user_id`, HashToken(token)).Scan(&wsID, &owner)
	if err != nil {
		return uuid.Nil, mapErr(err)
	}
	if owner != userID {
		return uuid.Nil, ErrForbidden
	}
	return wsID, nil
}

// BindInstallation attaches an installation to an organisation.
// ErrForeignReference when it already belongs to a different one.
func (s *Store) BindInstallation(ctx context.Context, installationID int64, accountLogin string, workspaceID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var current *uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT workspace_id FROM github_installation WHERE id = $1 FOR UPDATE`, installationID).Scan(&current)
		if err != nil && mapErr(err) != ErrNotFound {
			return err
		}
		if current != nil && *current != workspaceID {
			return ErrForeignReference
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO github_installation (id, account_login, workspace_id, suspended_at)
			VALUES ($1, $2, $3, NULL)
			ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login,
			    workspace_id = EXCLUDED.workspace_id, suspended_at = NULL`,
			installationID, accountLogin, workspaceID)
		return err
	})
}

// SyncInstallationRepos makes the installation's repositories exactly the
// given list. Removed repositories cascade their pull requests: the
// evidence belonged to access the organisation no longer has.
func (s *Store) SyncInstallationRepos(ctx context.Context, installationID int64, repos []InstallationRepo) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		var wsID uuid.UUID
		if err := tx.QueryRow(ctx, `
			SELECT workspace_id FROM github_installation WHERE id = $1 AND workspace_id IS NOT NULL`,
			installationID).Scan(&wsID); err != nil {
			return mapErr(err)
		}
		keep := make([]int64, 0, len(repos))
		for _, r := range repos {
			keep = append(keep, r.GitHubID)
			if _, err := tx.Exec(ctx, `
				INSERT INTO repo (workspace_id, installation_id, github_id, owner, name, default_branch)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (github_id) DO UPDATE SET
					owner = EXCLUDED.owner, name = EXCLUDED.name,
					default_branch = EXCLUDED.default_branch,
					installation_id = EXCLUDED.installation_id,
					workspace_id = EXCLUDED.workspace_id`,
				wsID, installationID, r.GitHubID, r.Owner, r.Name, r.DefaultBranch); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `
			DELETE FROM repo WHERE installation_id = $1 AND NOT (github_id = ANY($2))`, installationID, keep)
		return err
	})
}

func (s *Store) RemoveInstallationRepos(ctx context.Context, installationID int64, githubIDs []int64) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM repo WHERE installation_id = $1 AND github_id = ANY($2)`, installationID, githubIDs)
	return err
}

func (s *Store) SetInstallationSuspended(ctx context.Context, installationID int64, suspended bool) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE github_installation
		SET suspended_at = CASE WHEN $2 THEN COALESCE(suspended_at, now()) ELSE NULL END
		WHERE id = $1`, installationID, suspended)
	return err
}

func (s *Store) InstallationForWorkspace(ctx context.Context, workspaceID uuid.UUID) (Installation, error) {
	var i Installation
	err := s.pool.QueryRow(ctx, `
		SELECT id, account_login, workspace_id, suspended_at
		FROM github_installation WHERE workspace_id = $1`, workspaceID).
		Scan(&i.ID, &i.AccountLogin, &i.WorkspaceID, &i.SuspendedAt)
	return i, mapErr(err)
}
```

In `pull_request.go`, delete `LinkRepo` and `LinkRepoInput`, and change `ReposDueForSync` to join the installation:

```go
	rows, err := s.pool.Query(ctx, `
		SELECT `+repoCols+`
		FROM repo r JOIN github_installation gi ON gi.id = r.installation_id
		WHERE gi.suspended_at IS NULL
		  AND (r.synced_at IS NULL OR r.synced_at < now() - $1::interval)
		ORDER BY r.synced_at NULLS FIRST`, olderThan.String())
```

Adjust `repoCols` to use the `r.` alias if it does not already. `UpsertInstallation` stays for the worker, but it must not clear `workspace_id`; its `ON CONFLICT` only touches `account_login` and `suspended_at`, which is already the case.

In `fixtures.go`, `LinkRepo(t, f, githubID, owner, name)` becomes:

```go
func LinkRepo(t *testing.T, f *Fixture, githubID int64, owner, name string) store.Repo {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, f.Store.BindInstallation(ctx, 99, owner, f.WorkspaceID))
	require.NoError(t, f.Store.SyncInstallationRepos(ctx, 99, []store.InstallationRepo{{GitHubID: githubID, Owner: owner, Name: name, DefaultBranch: "main"}}))
	repo, err := f.Store.RepoByGitHubID(ctx, githubID)
	require.NoError(t, err)
	return repo
}
```

- [ ] **Step 4: Run the store tests**

Run: `cd api && go test ./internal/store/ ./internal/testutil/`
Expected: PASS.

- [ ] **Step 5: Extend the GitHub client**

In `api/internal/github/client.go` add, following the style of `ListPullRequests`:

```go
type InstallationInfo struct {
	ID           int64
	AccountLogin string
}

type RepoInfo struct {
	ID            int64
	Owner         string
	Name          string
	DefaultBranch string
}

// GetInstallation reads an installation as the App itself (JWT auth).
func (c *Client) GetInstallation(ctx context.Context, id int64) (InstallationInfo, error) {
	jwt, err := c.appJWT()
	if err != nil {
		return InstallationInfo{}, err
	}
	var body struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	}
	if err := c.getJSON(ctx, fmt.Sprintf("/app/installations/%d", id), "Bearer "+jwt, &body); err != nil {
		return InstallationInfo{}, err
	}
	return InstallationInfo{ID: body.ID, AccountLogin: body.Account.Login}, nil
}

// ListInstallationRepositories walks every page of the installation's
// repositories with an installation token.
func (c *Client) ListInstallationRepositories(ctx context.Context, installationID int64) ([]RepoInfo, error) {
	tok, err := c.InstallationToken(ctx, installationID)
	if err != nil {
		return nil, err
	}
	var out []RepoInfo
	for page := 1; ; page++ {
		var body struct {
			Repositories []struct {
				ID            int64  `json:"id"`
				Name          string `json:"name"`
				DefaultBranch string `json:"default_branch"`
				Owner         struct {
					Login string `json:"login"`
				} `json:"owner"`
			} `json:"repositories"`
		}
		if err := c.getJSON(ctx, fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page), "Bearer "+tok, &body); err != nil {
			return nil, err
		}
		for _, r := range body.Repositories {
			out = append(out, RepoInfo{ID: r.ID, Owner: r.Owner.Login, Name: r.Name, DefaultBranch: r.DefaultBranch})
		}
		if len(body.Repositories) < 100 {
			return out, nil
		}
	}
}

func (c *Client) GetRepository(ctx context.Context, installationID int64, owner, name string) (RepoInfo, error) {
	tok, err := c.InstallationToken(ctx, installationID)
	if err != nil {
		return RepoInfo{}, err
	}
	var body struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		DefaultBranch string `json:"default_branch"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := c.getJSON(ctx, fmt.Sprintf("/repos/%s/%s", owner, name), "Bearer "+tok, &body); err != nil {
		return RepoInfo{}, err
	}
	return RepoInfo{ID: body.ID, Owner: body.Owner.Login, Name: body.Name, DefaultBranch: body.DefaultBranch}, nil
}
```

If the client has no shared `getJSON(ctx, path, authorization string, dst any) error` helper, extract one from `ListPullRequests` first: build the request against `c.baseURL+path`, set `Accept: application/vnd.github+json` and the `Authorization` header, treat non-2xx as an error carrying the status, decode into `dst`. `appJWT` exists in `auth.go`; export nothing, just call it.

Add a test in `client_test.go` using the existing stub-server pattern: serve `/app/installations/99` and two pages of `/installation/repositories`, assert both repos come back with owners and default branches.

- [ ] **Step 6: Worker: installation events**

Rewrite `api/internal/worker/installation.go`:

```go
package worker

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
	Repositories        []eventRepo `json:"repositories"`
	RepositoriesAdded   []eventRepo `json:"repositories_added"`
	RepositoriesRemoved []eventRepo `json:"repositories_removed"`
}

type eventRepo struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
}

// handleInstallation keeps the installation row and its repositories in
// step with GitHub. Repositories are only touched for installations an
// organisation has bound; an App installed straight from GitHub waits
// until an admin connects it.
func (w *Worker) handleInstallation(ctx context.Context, eventType string, payload []byte) error {
	var ev installationEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	id := ev.Installation.ID
	if err := w.store.UpsertInstallation(ctx, id, ev.Installation.Account.Login, false); err != nil {
		return err
	}
	switch {
	case eventType == "installation" && (ev.Action == "deleted" || ev.Action == "suspend"):
		return w.store.SetInstallationSuspended(ctx, id, true)
	case eventType == "installation" && ev.Action == "unsuspend":
		return w.store.SetInstallationSuspended(ctx, id, false)
	case eventType == "installation" && ev.Action == "created":
		return w.syncRepos(ctx, id, ev.Repositories)
	case eventType == "installation_repositories":
		if len(ev.RepositoriesRemoved) > 0 {
			ids := make([]int64, 0, len(ev.RepositoriesRemoved))
			for _, r := range ev.RepositoriesRemoved {
				ids = append(ids, r.ID)
			}
			if err := w.store.RemoveInstallationRepos(ctx, id, ids); err != nil {
				return err
			}
		}
		return w.addRepos(ctx, id, ev.RepositoriesAdded)
	}
	return nil
}

// syncRepos replaces the list; addRepos only adds. Both need the default
// branch, which the event payload omits, so each repository is read once.
func (w *Worker) syncRepos(ctx context.Context, installationID int64, repos []eventRepo) error {
	list, ok, err := w.describe(ctx, installationID, repos)
	if err != nil || !ok {
		return err
	}
	return w.store.SyncInstallationRepos(ctx, installationID, list)
}

func (w *Worker) addRepos(ctx context.Context, installationID int64, repos []eventRepo) error {
	if len(repos) == 0 {
		return nil
	}
	list, ok, err := w.describe(ctx, installationID, repos)
	if err != nil || !ok {
		return err
	}
	// SyncInstallationRepos would delete the others, so upsert through the
	// same call with the existing ones included.
	existing, err := w.store.ReposForInstallation(ctx, installationID)
	if err != nil {
		return err
	}
	for _, r := range existing {
		list = append(list, store.InstallationRepo{GitHubID: r.GitHubID, Owner: r.Owner, Name: r.Name, DefaultBranch: r.DefaultBranch})
	}
	return w.store.SyncInstallationRepos(ctx, installationID, list)
}

// describe returns false when the installation is not bound to an
// organisation or the App client is absent; neither is an error.
func (w *Worker) describe(ctx context.Context, installationID int64, repos []eventRepo) ([]store.InstallationRepo, bool, error) {
	bound, err := w.store.InstallationIsBound(ctx, installationID)
	if err != nil || !bound || w.gh == nil {
		return nil, false, err
	}
	out := make([]store.InstallationRepo, 0, len(repos))
	for _, r := range repos {
		owner, name, ok := splitFullName(r.FullName)
		if !ok {
			continue
		}
		info, err := w.gh.GetRepository(ctx, installationID, owner, name)
		if err != nil {
			slog.Warn("describe repository", "repo", r.FullName, "err", err)
			continue
		}
		out = append(out, store.InstallationRepo{GitHubID: info.ID, Owner: info.Owner, Name: info.Name, DefaultBranch: info.DefaultBranch})
	}
	return out, true, nil
}

func splitFullName(full string) (string, string, bool) {
	for i := 0; i < len(full); i++ {
		if full[i] == '/' {
			return full[:i], full[i+1:], i > 0 && i < len(full)-1
		}
	}
	return "", "", false
}
```

Add to `github_setup.go` in the store:

```go
func (s *Store) InstallationIsBound(ctx context.Context, installationID int64) (bool, error) {
	var bound bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM github_installation WHERE id = $1 AND workspace_id IS NOT NULL)`, installationID).Scan(&bound)
	return bound, err
}

func (s *Store) ReposForInstallation(ctx context.Context, installationID int64) ([]Repo, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+repoCols+` FROM repo r WHERE r.installation_id = $1`, installationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Repo
	for rows.Next() {
		r, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

In `worker.go`'s `processDelivery` switch, pass the event type: `case "installation", "installation_repositories": return w.handleInstallation(ctx, eventType, payload)`.

Write `api/internal/worker/installation_test.go` with the stub-server pattern from `reconcile_test.go`: bind installation 99 to the fixture workspace, serve `/repos/acme/a` and `/repos/acme/b` from the stub, deliver an `installation_repositories` payload with `repositories_added: [{id:1, full_name:"acme/a"}]` through `store.RecordDelivery` and `worker.ProcessOnce`, assert one repo; deliver `repositories_removed: [{id:1}]`, assert none; deliver `installation` with `action: "suspend"`, assert `SuspendedAt` set; deliver `unsuspend`, assert cleared.

- [ ] **Step 7: Write the failing API tests**

`api/internal/api/github_setup_test.go`:

```go
package api_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestConnectGitHubRoundTrip(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/777":
			w.Write([]byte(`{"id":777,"account":{"login":"acme"}}`))
		case "/app/installations/777/access_tokens":
			w.WriteHeader(201)
			w.Write([]byte(`{"token":"ghs_x","expires_at":"2099-01-01T00:00:00Z"}`))
		case "/installation/repositories":
			w.Write([]byte(`{"repositories":[{"id":1,"name":"a","default_branch":"main","owner":{"login":"acme"}}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer stub.Close()
	f := testutil.NewFixtureWithGitHub(t, stub)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/github/connect", nil)
	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "https://github.com/apps/velvet-worklog/installations/new", loc.Scheme+"://"+loc.Host+loc.Path)
	state := loc.Query().Get("state")
	require.NotEmpty(t, state)

	rec = f.Do(http.MethodGet, "/api/v1/github/setup?installation_id=777&setup_action=install&state="+url.QueryEscape(state), nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Equal(t, "/w/lab/admin", rec.Header().Get("Location"))

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/github", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"account_login":"acme"`)
	require.Contains(t, rec.Body.String(), `"name":"a"`)

	// Replaying the state fails.
	rec = f.Do(http.MethodGet, "/api/v1/github/setup?installation_id=777&state="+url.QueryEscape(state), nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Contains(t, rec.Header().Get("Location"), "error=state")
}

func TestConnectGitHubRequiresAdminAndClient(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodGet, "/api/v1/w/lab/github/connect", nil)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, "no App configured")
}
```

Add `NewFixtureWithGitHub(t, stub *httptest.Server) *Fixture` to the fixture: builds a `github.NewClient("1", testPrivateKeyPEM, stub.URL)` (reuse the key `NewWorker` uses) and passes it in `api.Deps{Mailer: mailer, GitHub: client}`, and sets `cfg.GitHubAppSlug = "velvet-worklog"`.

- [ ] **Step 8: Implement the API**

`api/internal/api/github_setup.go`:

```go
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerGitHubSetupRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/w/{slug}/github", s.RequireAuth(s.RequireWorkspace(http.HandlerFunc(s.handleGitHubStatus))))
	mux.Handle("GET /api/v1/w/{slug}/github/connect", s.RequireAuth(s.RequireWorkspace(RequireRole("admin")(http.HandlerFunc(s.handleGitHubConnect)))))
	mux.Handle("GET /api/v1/github/setup", s.RequireAuth(http.HandlerFunc(s.handleGitHubSetup)))
}

func (s *Server) handleGitHubStatus(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	var inst *store.Installation
	if i, err := s.store.InstallationForWorkspace(r.Context(), ws.WorkspaceID); err == nil {
		inst = &i
	} else if !errors.Is(err, store.ErrNotFound) {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the installation")
		return
	}
	repos, err := s.store.ListRepos(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list repositories")
		return
	}
	if repos == nil {
		repos = []store.Repo{}
	}
	WriteJSON(w, http.StatusOK, map[string]any{"installation": inst, "repos": repos, "app_slug": s.cfg.GitHubAppSlug})
}

func (s *Server) handleGitHubConnect(w http.ResponseWriter, r *http.Request) {
	if s.gh == nil || s.cfg.GitHubAppSlug == "" {
		WriteError(w, http.StatusServiceUnavailable, "github_unconfigured", "the GitHub App is not configured on this server")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	state, err := s.store.IssueSetupState(r.Context(), ws.WorkspaceID, user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start the connection")
		return
	}
	target := "https://github.com/apps/" + url.PathEscape(s.cfg.GitHubAppSlug) + "/installations/new?state=" + url.QueryEscape(state)
	http.Redirect(w, r, target, http.StatusFound)
}

// handleGitHubSetup is where GitHub sends the admin back. Every failure
// redirects into the app with an error code rather than showing raw JSON,
// because a person, not a script, is on the other end.
func (s *Server) handleGitHubSetup(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	fail := func(code string) {
		http.Redirect(w, r, "/?error="+code, http.StatusFound)
	}
	wsID, err := s.store.ConsumeSetupState(r.Context(), r.URL.Query().Get("state"), user.ID)
	if err != nil {
		fail("state")
		return
	}
	installationID, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	if err != nil {
		fail("installation")
		return
	}
	m, err := s.store.MembershipByWorkspace(r.Context(), user.ID, wsID)
	if err != nil || m.Role != "admin" {
		fail("role")
		return
	}
	if s.gh == nil {
		fail("unconfigured")
		return
	}
	info, err := s.gh.GetInstallation(r.Context(), installationID)
	if err != nil {
		slog.Error("read installation", "err", err)
		fail("github")
		return
	}
	if err := s.store.BindInstallation(r.Context(), installationID, info.AccountLogin, wsID); err != nil {
		if errors.Is(err, store.ErrForeignReference) {
			http.Redirect(w, r, "/w/"+m.Slug+"/admin?error=installation_taken", http.StatusFound)
			return
		}
		fail("bind")
		return
	}
	repos, err := s.gh.ListInstallationRepositories(r.Context(), installationID)
	if err != nil {
		slog.Error("list installation repositories", "err", err)
		http.Redirect(w, r, "/w/"+m.Slug+"/admin?error=repos", http.StatusFound)
		return
	}
	list := make([]store.InstallationRepo, 0, len(repos))
	for _, rp := range repos {
		list = append(list, store.InstallationRepo{GitHubID: rp.ID, Owner: rp.Owner, Name: rp.Name, DefaultBranch: rp.DefaultBranch})
	}
	if err := s.store.SyncInstallationRepos(r.Context(), installationID, list); err != nil {
		fail("sync")
		return
	}
	http.Redirect(w, r, "/w/"+m.Slug+"/admin", http.StatusFound)
}
```

Add to `user.go`:

```go
func (s *Store) MembershipByWorkspace(ctx context.Context, userID, workspaceID uuid.UUID) (Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		SELECT m.id, m.workspace_id, w.slug, w.name, m.role::text
		FROM membership m JOIN workspace w ON w.id = m.workspace_id
		WHERE m.user_id = $1 AND m.workspace_id = $2`, userID, workspaceID).
		Scan(&m.ID, &m.WorkspaceID, &m.Slug, &m.Name, &m.Role)
	return m, mapErr(err)
}
```

In `github.go` delete `handleLinkRepo` and the `POST /api/v1/w/{slug}/repos` registration; keep `GET .../repos`. Register `s.registerGitHubSetupRoutes(mux)`. In `main.go` build the GitHub client for `serve` the same way the `worker` branch does and pass it in `Deps`. Delete `deploy/connect-repo.sh`.

- [ ] **Step 9: Run everything**

Run: `cd api && go build ./... && go vet ./... && go test -count=1 ./...`
Expected: PASS. `github_test.go` tests of the removed `POST /repos` must be deleted.

- [ ] **Step 10: Commit**

```bash
git add -A api deploy
git commit -m "Connect GitHub by installing the App on an organisation"
```

---

### Task 10: Link a GitHub account to a user

**Files:**
- Create: `api/internal/api/github_link.go`
- Modify: `api/internal/auth/github.go`, `api/internal/api/server.go`
- Test: `api/internal/api/github_link_test.go`

**Interfaces:**
- Consumes: `store.LinkGitHub`, `store.UnlinkGitHub`, `auth.OAuthConfig`, `auth.FetchIdentity`.
- Endpoints: `GET /api/v1/auth/github/link?next=/w/velvet/settings/profile` (signed in) → 302 to GitHub with a state cookie; `GET /api/v1/auth/github/callback` (signed in) → links, 302 to `next` or `/?github=linked`; `DELETE /api/v1/me/github` → 204.

- [ ] **Step 1: Write the failing test**

```go
package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestLinkGitHubStartsOAuthAndUnlinks(t *testing.T) {
	f := testutil.NewFixture(t)
	f.Cfg.GitHubClientID = "cid"
	f.Cfg.GitHubClientSecret = "sec"

	rec := f.Do(http.MethodGet, "/api/v1/auth/github/link?next=/w/lab/settings/profile", nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Contains(t, rec.Header().Get("Location"), "https://github.com/login/oauth/authorize")
	require.Contains(t, rec.Header().Get("Location"), "client_id=cid")
	var state, next string
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case "ticket_oauth_state":
			state = c.Value
		case "ticket_oauth_next":
			next = c.Value
		}
	}
	require.NotEmpty(t, state)
	require.Equal(t, "/w/lab/settings/profile", next)

	rec = f.DoAnon(http.MethodGet, "/api/v1/auth/github/link", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, "linking needs a session")

	rec = f.Do(http.MethodDelete, "/api/v1/me/github", nil)
	require.Equal(t, http.StatusNoContent, rec.Code)
	rec = f.Do(http.MethodGet, "/api/v1/me", nil)
	require.Contains(t, rec.Body.String(), `"github_login":""`)
}

func TestLinkGitHubCallbackRejectsBadState(t *testing.T) {
	f := testutil.NewFixture(t)
	req := f.Request(http.MethodGet, "/api/v1/auth/github/callback?code=x&state=wrong", nil)
	req.AddCookie(&http.Cookie{Name: "ticket_session", Value: f.Token})
	req.AddCookie(&http.Cookie{Name: "ticket_oauth_state", Value: "right"})
	rec := f.Serve(req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

var _ = httptest.NewServer
```

Expose `Cfg *config.Config` on the fixture so tests can set OAuth values before the request; `NewServer` keeps the pointer, so changes after construction are visible.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && go test ./internal/api/ -run LinkGitHub`
Expected: FAIL, 404 on the link route.

- [ ] **Step 3: Implement**

`api/internal/api/github_link.go`:

```go
package api

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

const (
	oauthStateCookie = "ticket_oauth_state"
	oauthNextCookie  = "ticket_oauth_next"
)

func (s *Server) registerGitHubLinkRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/auth/github/link", s.RequireAuth(http.HandlerFunc(s.handleGitHubLinkStart)))
	mux.Handle("GET /api/v1/auth/github/callback", s.RequireAuth(http.HandlerFunc(s.handleGitHubLinkCallback)))
	mux.Handle("DELETE /api/v1/me/github", s.RequireAuth(http.HandlerFunc(s.handleGitHubUnlink)))
}

// safeNext only allows in-app paths, so the callback cannot be used as an
// open redirect.
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		return "/"
	}
	return next
}

func (s *Server) handleGitHubLinkStart(w http.ResponseWriter, r *http.Request) {
	if s.cfg.GitHubClientID == "" {
		WriteError(w, http.StatusServiceUnavailable, "github_unconfigured", "GitHub sign-in is not configured on this server")
		return
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start the link")
		return
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	secure := s.secureCookies()
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: state, Path: "/api/v1/auth/github", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	http.SetCookie(w, &http.Cookie{Name: oauthNextCookie, Value: safeNext(r.URL.Query().Get("next")), Path: "/api/v1/auth/github", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	http.Redirect(w, r, cfg.AuthCodeURL(state), http.StatusFound)
}

func (s *Server) handleGitHubLinkCallback(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	c, err := r.Cookie(oauthStateCookie)
	if err != nil || c.Value == "" || c.Value != r.URL.Query().Get("state") {
		WriteError(w, http.StatusBadRequest, "bad_state", "the sign-in state did not match; start again")
		return
	}
	next := "/?github=linked"
	if n, err := r.Cookie(oauthNextCookie); err == nil {
		next = safeNext(n.Value)
	}
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	tok, err := cfg.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "exchange_failed", "could not complete the GitHub link")
		return
	}
	identity, err := auth.FetchIdentity(r.Context(), cfg, tok)
	if err != nil {
		WriteError(w, http.StatusBadGateway, "github_unavailable", "could not reach GitHub")
		return
	}
	if _, err := s.store.LinkGitHub(r.Context(), user.ID, identity); err != nil {
		if errors.Is(err, store.ErrDuplicate) {
			http.Redirect(w, r, next+"?error=github_taken", http.StatusFound)
			return
		}
		WriteError(w, http.StatusInternalServerError, "internal", "could not link the account")
		return
	}
	http.Redirect(w, r, next, http.StatusFound)
}

func (s *Server) handleGitHubUnlink(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	if err := s.store.UnlinkGitHub(r.Context(), user.ID); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not unlink")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

Register `s.registerGitHubLinkRoutes(mux)`. `auth.OAuthConfig` keeps its `/api/v1/auth/github/callback` redirect, so the OAuth App on GitHub needs no change.

- [ ] **Step 4: Run the tests**

Run: `cd api && go test ./internal/api/ -run LinkGitHub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "Link a GitHub account to a signed-in user for PR attribution"
```

---

### Task 11: Remember the last organisation

**Files:**
- Modify: `api/internal/api/auth.go`, `api/internal/store/user.go`
- Test: `api/internal/api/auth_test.go`

**Interfaces:**
- Produces: `store.TouchLastWorkspace(ctx, sessionToken string, workspaceID uuid.UUID) error`; `store.LastWorkspaceSlug(ctx, sessionToken string) (string, error)`; `/me` response gains `"last_workspace": "<slug>"|null`.

- [ ] **Step 1: Write the failing test**

Append to `auth_test.go`:

```go
func TestMeRemembersLastOrganisation(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := f.Do(http.MethodGet, "/api/v1/me", nil)
	require.Contains(t, rec.Body.String(), `"last_workspace":null`)
	f.Do(http.MethodGet, "/api/v1/w/lab/members", nil)
	rec = f.Do(http.MethodGet, "/api/v1/me", nil)
	require.Contains(t, rec.Body.String(), `"last_workspace":"lab"`)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && go test ./internal/api/ -run TestMeRemembersLastOrganisation`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `user.go`:

```go
// TouchLastWorkspace records the organisation a session last used. The
// WHERE avoids a write on every request once it is already set.
func (s *Store) TouchLastWorkspace(ctx context.Context, token string, workspaceID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session SET last_workspace_id = $2
		WHERE id = $1 AND last_workspace_id IS DISTINCT FROM $2`, HashToken(token), workspaceID)
	return err
}

func (s *Store) LastWorkspaceSlug(ctx context.Context, token string) (string, error) {
	var slug *string
	err := s.pool.QueryRow(ctx, `
		SELECT w.slug FROM session s
		LEFT JOIN workspace w ON w.id = s.last_workspace_id
		WHERE s.id = $1`, HashToken(token)).Scan(&slug)
	if err != nil {
		return "", mapErr(err)
	}
	if slug == nil {
		return "", nil
	}
	return *slug, nil
}
```

In `auth.go`, `RequireWorkspace`: after resolving the membership, read the cookie and call `s.store.TouchLastWorkspace(r.Context(), c.Value, m.WorkspaceID)`, logging but not failing on error. In `handleMe`, read the cookie, call `LastWorkspaceSlug`, and add `"last_workspace": slugOrNil` to the response where an empty string becomes `nil`.

- [ ] **Step 4: Run the tests**

Run: `cd api && go test -count=1 ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "Remember the organisation a session last used"
```

---

### Task 12: Web: email sign-in, session hook, public routes

**Files:**
- Create: `web/src/features/auth/EmailSignIn.tsx`, `web/src/features/auth/CheckEmail.tsx`, `web/src/features/auth/Expired.tsx`, `web/src/features/auth/emailSignIn.test.tsx`
- Modify: `web/src/lib/types.ts`, `web/src/features/auth/useSession.ts`, `web/src/routes/router.tsx`, `web/src/routes/root.tsx`
- Delete: `web/src/features/auth/SignIn.tsx`, `web/src/features/auth/NotInvited.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/auth/email`, `GET /api/v1/me` with `last_workspace`.
- Produces: `types.User.email: string`, `types.SessionPayload.last_workspace: string | null`; routes `/signin`, `/check-email`, `/expired`; `useSession()` unchanged in shape minus `isNotInvited`.

- [ ] **Step 1: Update the types**

In `web/src/lib/types.ts`:

```ts
export interface User {
  id: string
  email: string
  github_id: number
  github_login: string
  name: string
  avatar_url: string
}

export interface SessionPayload {
  user: User
  memberships: Membership[]
  last_workspace: string | null
}

export interface Invite {
  id: string
  workspace_id: string
  email: string
  role: Role
  expires_at: string
}

export interface InvitePreview {
  invite: { id: string; email: string; role: Role; org_name: string; org_slug: string; inviter_name: string }
  signed_in: boolean
  email_matches: boolean
}

export interface Installation {
  id: number
  account_login: string
  suspended_at: string | null
}

export interface GitHubStatus {
  installation: Installation | null
  repos: Repo[]
  app_slug: string
}
```

Remove `invited_login` from `WorkspaceMembership` and make `user: User`.

- [ ] **Step 2: Write the failing component test**

`web/src/features/auth/emailSignIn.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { EmailSignIn } from './EmailSignIn'

afterEach(() => vi.unstubAllGlobals())

test('submits the address and shows the check-email message', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ status: 'sent' }) } as Response)
  vi.stubGlobal('fetch', fetchMock)
  render(<EmailSignIn />)

  await userEvent.type(screen.getByLabelText(/email/i), 'me@example.com')
  await userEvent.click(screen.getByRole('button', { name: /send/i }))

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/email', expect.objectContaining({ method: 'POST' }))
  expect(await screen.findByText(/check your email/i)).toBeInTheDocument()
  expect(screen.getByText(/me@example.com/)).toBeInTheDocument()
})

test('shows the rate limit message', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 429,
    json: async () => ({ error: { code: 'rate_limited', message: 'too many sign-in requests, try again later' } }),
  } as Response))
  render(<EmailSignIn />)
  await userEvent.type(screen.getByLabelText(/email/i), 'me@example.com')
  await userEvent.click(screen.getByRole('button', { name: /send/i }))
  expect(await screen.findByText(/too many sign-in requests/i)).toBeInTheDocument()
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd web && npx vitest run src/features/auth/emailSignIn.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the pages**

`web/src/features/auth/EmailSignIn.tsx`:

```tsx
import { useState, type FormEvent } from 'react'

import { api, ApiError } from '../../lib/api'
import { Button } from '../../ui/Button'

export function EmailSignIn() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/email', { email })
      setSentTo(email)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
        <h1 className="text-lg text-ink">Check your email</h1>
        <p className="mt-2 text-sm text-grey-700">
          We sent a sign-in link to <span className="text-ink">{sentTo}</span>. It works once and expires in 15 minutes.
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
      <h1 className="text-lg text-ink">Sign in</h1>
      <p className="mt-1 text-sm text-grey-700">Enter your email and we will send you a link. No password.</p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <label className="block text-sm">
          <span className="text-grey-700">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full border border-grey-300 bg-paper px-2 py-1"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {error ? <p role="alert" className="text-sm text-ink">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send sign-in link'}
        </Button>
      </form>
    </main>
  )
}
```

`web/src/features/auth/CheckEmail.tsx` renders the same "Check your email" card for the invite flow, reading the address from the `?email=` search param via `useSearch({ strict: false })`. `web/src/features/auth/Expired.tsx`:

```tsx
import { Link } from '@tanstack/react-router'

export function Expired() {
  return (
    <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
      <h1 className="text-lg text-ink">That link has expired</h1>
      <p className="mt-2 text-sm text-grey-700">Sign-in links work once and last 15 minutes. Invitation links last 7 days.</p>
      <Link to="/signin" className="mt-4 inline-block text-sm text-ink underline">Request a new link</Link>
    </main>
  )
}
```

Delete `SignIn.tsx` and `NotInvited.tsx`. In `useSession.ts` remove `isNotInvited` and expose `lastWorkspace: data?.last_workspace ?? null`.

- [ ] **Step 5: Routes**

In `router.tsx`: replace the `/signin` component with `EmailSignIn`; delete the `/not-invited` route; add `/check-email` → `CheckEmail` and `/expired` → `Expired`. In `root.tsx`:

```ts
const PUBLIC_ROUTES = new Set(['/signin', '/check-email', '/expired'])
const isPublicAuthRoute = PUBLIC_ROUTES.has(pathname) || pathname.startsWith('/invite/')
```

Update `indexRoute.beforeLoad`: if `last_workspace` is set and still among the memberships, redirect there; else if any membership, redirect to the first; else redirect to `/orgs/new` (Task 13 adds the route; until then this redirect 404s, which is expected).

- [ ] **Step 6: Run the web checks**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS. `shell.test.tsx` and `router.test.tsx` fixtures that mock `/me` need `email` and `last_workspace` added to their payloads, and any test of the not-invited route is deleted.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "Sign in with an email link in the web app"
```

---

### Task 13: Web: create an organisation, landing page, accept an invite

**Files:**
- Create: `web/src/features/orgs/NewOrg.tsx`, `web/src/features/orgs/Landing.tsx`, `web/src/features/orgs/AcceptInvite.tsx`, `web/src/features/orgs/orgs.test.tsx`
- Modify: `web/src/routes/router.tsx`, `web/src/app/Shell.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/orgs`, `GET /api/v1/invite/{token}`, `POST /api/v1/invite/{token}/accept`.
- Routes: `/orgs/new` (signed in, no shell), `/invite/$token` (public).

- [ ] **Step 1: Write the failing tests**

`web/src/features/orgs/orgs.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { NewOrg } from './NewOrg'
import { AcceptInvite } from './AcceptInvite'

function wrap(node: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

afterEach(() => vi.unstubAllGlobals())

test('suggests a slug from the name and creates the organisation', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 201,
    json: async () => ({ id: '1', workspace_id: '2', workspace_slug: 'velvet-team', workspace_name: 'Velvet Team', role: 'admin' }),
  } as Response)
  vi.stubGlobal('fetch', fetchMock)
  const onCreated = vi.fn()
  render(wrap(<NewOrg onCreated={onCreated} />))

  await userEvent.type(screen.getByLabelText(/^name/i), 'Velvet Team')
  expect(screen.getByLabelText(/slug/i)).toHaveValue('velvet-team')
  expect(screen.getByLabelText(/prefix/i)).toHaveValue('VT')
  await userEvent.click(screen.getByRole('button', { name: /create/i }))

  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Velvet Team', slug: 'velvet-team', issue_prefix: 'VT' })
  expect(onCreated).toHaveBeenCalledWith('velvet-team')
})

test('shows the slug-taken error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 409, json: async () => ({ error: { code: 'slug_taken', message: 'that slug is already in use' } }),
  } as Response))
  render(wrap(<NewOrg onCreated={() => {}} />))
  await userEvent.type(screen.getByLabelText(/^name/i), 'Velvet')
  await userEvent.click(screen.getByRole('button', { name: /create/i }))
  expect(await screen.findByText(/already in use/i)).toBeInTheDocument()
})

test('accept page shows the organisation and the wrong-email case', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({
      invite: { id: 'i', email: 'you@example.com', role: 'member', org_name: 'Velvet', org_slug: 'velvet', inviter_name: 'Sabari' },
      signed_in: true, email_matches: false,
    }),
  } as Response))
  render(wrap(<AcceptInvite token="t" onAccepted={() => {}} />))
  expect(await screen.findByText(/Sabari invited you to Velvet/)).toBeInTheDocument()
  expect(screen.getByText(/sent to you@example.com/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/features/orgs`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`web/src/features/orgs/NewOrg.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'

import { api, ApiError } from '../../lib/api'
import type { Membership } from '../../lib/types'
import { Button } from '../../ui/Button'

export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function prefixFromName(name: string): string {
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('')
  const base = (initials.length >= 2 ? initials : name.replace(/[^a-z]/gi, '')).toUpperCase()
  return base.slice(0, 6).padEnd(2, 'X')
}

export function NewOrg({ onCreated }: { onCreated: (slug: string) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [prefix, setPrefix] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [prefixEdited, setPrefixEdited] = useState(false)

  const create = useMutation({
    mutationFn: () => api.post<Membership>('/orgs', { name, slug, issue_prefix: prefix }),
    onSuccess: async (m) => {
      await queryClient.invalidateQueries({ queryKey: ['session'] })
      onCreated(m.workspace_slug)
    },
  })

  function onName(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugFromName(value))
    if (!prefixEdited) setPrefix(prefixFromName(value))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate()
  }

  const error = create.error instanceof ApiError ? create.error.message : create.error ? 'Something went wrong.' : null

  return (
    <main className="mx-auto mt-16 max-w-md border border-grey-200 p-6">
      <h1 className="text-lg text-ink">Create an organisation</h1>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3 text-sm">
        <label className="block">
          <span className="text-grey-700">Name</span>
          <input required className="mt-1 w-full border border-grey-300 bg-paper px-2 py-1" value={name} onChange={(e) => onName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-grey-700">Slug</span>
          <input required pattern="[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])" className="mt-1 w-full border border-grey-300 bg-paper px-2 py-1 font-mono"
            value={slug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value) }} />
          <span className="text-xs text-grey-700">Your organisation lives at /w/{slug || 'slug'}</span>
        </label>
        <label className="block">
          <span className="text-grey-700">Issue prefix</span>
          <input required pattern="[A-Z]{2,6}" className="mt-1 w-24 border border-grey-300 bg-paper px-2 py-1 font-mono"
            value={prefix} onChange={(e) => { setPrefixEdited(true); setPrefix(e.target.value.toUpperCase()) }} />
          <span className="ml-2 text-xs text-grey-700">Issues are numbered {prefix || 'ABC'}-1, {prefix || 'ABC'}-2…</span>
        </label>
        {error ? <p role="alert" className="text-ink">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={create.isPending}>Create organisation</Button>
      </form>
    </main>
  )
}
```

`web/src/features/orgs/Landing.tsx` wraps `NewOrg` and, above it, a short paragraph "You are signed in as {email}" with `SignOutButton`; it is what `/orgs/new` renders, using `useNavigate()` to go to `/w/${slug}` in `onCreated`.

`web/src/features/orgs/AcceptInvite.tsx`:

```tsx
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, ApiError } from '../../lib/api'
import type { InvitePreview, Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SignOutButton } from '../auth/SignOutButton'

export function AcceptInvite({ token, onAccepted }: { token: string; onAccepted: (slug: string) => void }) {
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api.get<InvitePreview>(`/invite/${token}`), retry: false })
  const [sentTo, setSentTo] = useState<string | null>(null)
  const accept = useMutation({
    mutationFn: () => api.post<Membership | { status: string; email: string }>(`/invite/${token}/accept`),
    onSuccess: (res) => {
      if ('workspace_slug' in res) onAccepted(res.workspace_slug)
      else setSentTo(res.email)
    },
  })

  if (preview.isLoading) return <main className="mx-auto mt-24 max-w-sm p-6 text-sm text-grey-700">Loading…</main>
  if (preview.error || !preview.data) {
    return (
      <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
        <h1 className="text-lg text-ink">This invitation is no longer valid</h1>
        <p className="mt-2 text-sm text-grey-700">It may have expired or been revoked. Ask the person who invited you to send a new one.</p>
      </main>
    )
  }
  const { invite, signed_in, email_matches } = preview.data
  if (sentTo) {
    return (
      <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
        <h1 className="text-lg text-ink">Check your email</h1>
        <p className="mt-2 text-sm text-grey-700">We sent a sign-in link to <span className="text-ink">{sentTo}</span>. Clicking it joins {invite.org_name}.</p>
      </main>
    )
  }
  const error = accept.error instanceof ApiError ? accept.error.message : null
  return (
    <main className="mx-auto mt-24 max-w-sm border border-grey-200 p-6">
      <h1 className="text-lg text-ink">{invite.inviter_name} invited you to {invite.org_name}</h1>
      <p className="mt-2 text-sm text-grey-700">You will join as {invite.role}. This invitation was sent to {invite.email}.</p>
      {signed_in && !email_matches ? (
        <div className="mt-4 text-sm">
          <p className="text-ink">You are signed in with a different address. Sign out, then open the link again.</p>
          <div className="mt-2"><SignOutButton /></div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {error ? <p role="alert" className="text-sm text-ink">{error}</p> : null}
          <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {signed_in ? 'Accept invitation' : 'Sign in and accept'}
          </Button>
        </div>
      )}
    </main>
  )
}
```

Routes in `router.tsx`: `/orgs/new` → `Landing`; `/invite/$token` → `AcceptInvite` with `onAccepted={(slug) => navigate({ to: `/w/${slug}` })}`.

In `Shell.tsx`: change the `<span className="sr-only">Workspace</span>` to `Organisation`, and add a `<Link to="/orgs/new">New organisation</Link>` under the switcher. Change any visible "workspace" copy in `Shell.tsx`, `Admin.tsx`, and `Dashboard.tsx` to "organisation"; `grep -rn -i workspace web/src --include=*.tsx | grep -v workspace_` lists the strings.

- [ ] **Step 4: Run the web checks**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Create organisations and accept invitations in the web app"
```

---

### Task 14: Web: Administration and profile

**Files:**
- Create: `web/src/features/admin/InvitePanel.tsx`, `web/src/features/admin/GitHubPanel.tsx`, `web/src/features/admin/DangerPanel.tsx`, `web/src/features/profile/Profile.tsx`, `web/src/features/admin/panels.test.tsx`
- Modify: `web/src/features/admin/Admin.tsx`, `web/src/features/admin/admin.test.tsx`, `web/src/routes/router.tsx`, `web/src/app/Shell.tsx`

**Interfaces:**
- Consumes: invites endpoints, `GET /w/{slug}/github`, `GET /w/{slug}/github/connect`, `DELETE /w/{slug}`, `POST /w/{slug}/leave`, `DELETE /w/{slug}/memberships/{id}`, `GET /auth/github/link`, `DELETE /me/github`.
- Route: `/w/$slug/settings/profile` → `Profile`.

- [ ] **Step 1: Write the failing tests**

`web/src/features/admin/panels.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { InvitePanel } from './InvitePanel'
import { GitHubPanel } from './GitHubPanel'

function wrap(node: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

afterEach(() => vi.unstubAllGlobals())

function respond(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const body = routes[key]
    if (body === undefined) throw new Error(`unexpected ${key}`)
    return { ok: true, status: 200, json: async () => body } as Response
  })
}

test('invite panel lists pending invites and sends one', async () => {
  const fetchMock = respond({
    'GET /api/v1/w/velvet/invites': [{ id: 'i1', workspace_id: 'w', email: 'a@example.com', role: 'member', expires_at: '2026-09-14T00:00:00Z' }],
    'POST /api/v1/w/velvet/invites': { id: 'i2', workspace_id: 'w', email: 'b@example.com', role: 'viewer', expires_at: '2026-09-14T00:00:00Z' },
  })
  vi.stubGlobal('fetch', fetchMock)
  render(wrap(<InvitePanel slug="velvet" />))
  expect(await screen.findByText('a@example.com')).toBeInTheDocument()

  await userEvent.type(screen.getByLabelText(/email/i), 'b@example.com')
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'viewer')
  await userEvent.click(screen.getByRole('button', { name: /send invite/i }))
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(post![1]!.body as string)).toEqual({ email: 'b@example.com', role: 'viewer' })
})

test('github panel offers connect when nothing is installed and lists repos when it is', async () => {
  vi.stubGlobal('fetch', respond({ 'GET /api/v1/w/velvet/github': { installation: null, repos: [], app_slug: 'velvet-worklog' } }))
  const { unmount } = render(wrap(<GitHubPanel slug="velvet" isAdmin />))
  const link = await screen.findByRole('link', { name: /connect github/i })
  expect(link).toHaveAttribute('href', '/api/v1/w/velvet/github/connect')
  unmount()

  vi.stubGlobal('fetch', respond({
    'GET /api/v1/w/velvet/github': {
      installation: { id: 9, account_login: 'acme', suspended_at: null },
      repos: [{ id: 'r', workspace_id: 'w', installation_id: 9, github_id: 1, owner: 'acme', name: 'a', default_branch: 'main', synced_at: null }],
      app_slug: 'velvet-worklog',
    },
  }))
  render(wrap(<GitHubPanel slug="velvet" isAdmin />))
  expect(await screen.findByText('acme/a')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /manage on github/i })).toHaveAttribute('href', 'https://github.com/settings/installations/9')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/features/admin/panels.test.tsx`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement the panels**

`InvitePanel.tsx`: a form with `email` and `role` fields posting to `/w/${slug}/invites`, then a list of pending invites from `['invites', slug]` with the email, role, expiry through `RelativeTime`, and two ghost buttons, Resend (`POST .../invites/${id}/resend`) and Revoke (`DELETE .../invites/${id}`), each invalidating `['invites', slug]`. Follow the mutation-with-local-error pattern from `UnlinkedPRs.tsx`.

`GitHubPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { GitHubStatus } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'

export function GitHubPanel({ slug, isAdmin }: { slug: string; isAdmin: boolean }) {
  const status = useQuery({ queryKey: ['github', slug], queryFn: () => api.get<GitHubStatus>(`/w/${slug}/github`) })
  if (!status.data) return null
  const { installation, repos } = status.data
  if (!installation) {
    return (
      <section aria-labelledby="github-heading">
        <h2 id="github-heading" className="text-ink">GitHub</h2>
        <EmptyState
          title="Not connected"
          message="Install the GitHub App to attach pull requests to issues as evidence. Only repositories you pick are read."
          action={isAdmin ? <a className="border border-grey-300 px-2 py-1 text-sm" href={`/api/v1/w/${slug}/github/connect`}>Connect GitHub</a> : undefined}
        />
      </section>
    )
  }
  return (
    <section aria-labelledby="github-heading">
      <h2 id="github-heading" className="text-ink">GitHub</h2>
      <p className="mt-1 text-sm text-grey-700">
        Installed on <span className="text-ink">{installation.account_login}</span>
        {installation.suspended_at ? ' (suspended on GitHub)' : ''}.{' '}
        <a className="underline" href={`https://github.com/settings/installations/${installation.id}`}>Manage on GitHub</a>
        {' '}to add or remove repositories, or uninstall to disconnect.
      </p>
      <ul className="mt-2 text-sm">
        {repos.map((r) => <li key={r.id} className="py-0.5">{r.owner}/{r.name}</li>)}
      </ul>
      {repos.length === 0 ? <p className="text-sm text-grey-700">No repositories granted yet.</p> : null}
    </section>
  )
}
```

`DangerPanel.tsx`: Leave organisation button (`POST /w/${slug}/leave`, then navigate to `/`), and for admins a Delete organisation form that requires typing the slug and posts `DELETE /w/${slug}` with `{confirm}`, then navigates to `/`. Show `last_admin` errors inline.

`Admin.tsx`: keep the members list with the role select, add a Remove ghost button per row (`DELETE .../memberships/${id}`), drop the old invite form and `RepositoryPanel`, and compose `InvitePanel`, `GitHubPanel`, `DangerPanel`. Update `admin.test.tsx` fixtures: memberships no longer carry `invited_login`, and the repo form assertions go.

`Profile.tsx`: shows the signed-in email, and either "GitHub: {github_login}" with an Unlink button (`DELETE /me/github`) or a "Link GitHub account" anchor to `/api/v1/auth/github/link?next=/w/${slug}/settings/profile`. One sentence explains why: pull requests you author appear under your name. Add the route and a "Profile" link at the bottom of the nav in `Shell.tsx`.

- [ ] **Step 4: Run the web checks**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Administer invites, GitHub, and membership from the web app"
```

---

### Task 15: End-to-end onboarding journey

**Files:**
- Create: `e2e/tests/onboarding.spec.ts`
- Modify: `e2e/tests/fixtures.ts`, `e2e/stack-up.sh`, `e2e/tests/workflow.spec.ts`, `e2e/tests/evidence.spec.ts`, `e2e/tests/worklog.spec.ts`

**Interfaces:**
- Consumes: the log mailer's line `mail (not sent) to=... links=[...]` in the API container log.
- Produces: `fixtures.ts` helpers `latestMailLink(to: string, contains: string): string`, `stubGitHubSetup()`.

- [ ] **Step 1: Update seeding to the new schema**

In `fixtures.ts` `seedWorkspace`: insert the user as `INSERT INTO app_user (email, github_id, github_login, name) VALUES ('sabari@example.com', 1, 'sabari', 'Sabari') ON CONFLICT (github_id) DO NOTHING`, and the membership as `INSERT INTO membership (workspace_id, user_id, role) SELECT w.id, u.id, 'admin' ... ON CONFLICT (workspace_id, user_id) DO NOTHING`. `seedRepo` must insert `github_installation (id, account_login, workspace_id)` bound to the workspace before the `repo` row.

Add:

```ts
/** Reads the newest sign-in or invite link the log mailer wrote for an address. */
export function latestMailLink(to: string, contains: string): string {
  const log = execFileSync(
    'docker',
    ['compose', '--env-file', envFile, '-p', project, 'logs', '--no-color', '--no-log-prefix', 'api'],
    { cwd: deployDir, encoding: 'utf8' },
  )
  const lines = log.split('\n').filter((l) => l.includes('mail (not sent)') && l.includes(`to=${to}`))
  const last = lines.at(-1)
  if (!last) throw new Error(`no mail logged for ${to}`)
  const match = last.match(/https?:\/\/[^\s\]"]+/g)?.filter((u) => u.includes(contains)).at(-1)
  if (!match) throw new Error(`no link containing ${contains} in: ${last}`)
  return match
}
```

The API's `BASE_URL` in the stack is `http://localhost:8099`, so the link is directly navigable.

- [ ] **Step 2: Point the stack at a stub GitHub for the setup callback**

`stack-up.sh` already supports `GITHUB_API_URL`. Add to the generated env file `GITHUB_APP_ID=1`, `GITHUB_APP_SLUG=velvet-worklog`, `GITHUB_API_URL=http://host.docker.internal:8097`, and a throwaway RSA key generated at start (`openssl genrsa 2048`) into `GITHUB_APP_PRIVATE_KEY` with quotes preserved. The e2e suite starts a stub on port 8097 before the tests that answer `/app/installations/777`, `/app/installations/777/access_tokens`, `/installation/repositories`, and `/repos/acme/*` with the same bodies as the Go test in Task 9, using Node's `http` module inside `fixtures.ts` (`stubGitHubSetup()` returns a `close()`), started in `onboarding.spec.ts`'s `beforeAll`. On Linux runners `host.docker.internal` needs `extra_hosts: ["host.docker.internal:host-gateway"]` on the `api` and `worker` services in `docker-compose.yml`; add it, it is harmless in production.

- [ ] **Step 3: Write the journey**

`e2e/tests/onboarding.spec.ts`:

```ts
import { expect, test as base, type Browser } from '@playwright/test'

import { latestMailLink, resetWorkspaceData, sql, stubGitHubSetup } from './fixtures'

const test = base
test.describe.configure({ mode: 'serial' })

let stub: { close(): void }
test.beforeAll(() => {
  sql(`DELETE FROM workspace; DELETE FROM app_user; DELETE FROM login_token; DELETE FROM github_installation;`)
  stub = stubGitHubSetup()
})
test.afterAll(() => stub.close())

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/signin')
  await page.getByLabel(/email/i).fill(email)
  await page.getByRole('button', { name: /send/i }).click()
  await expect(page.getByText(/check your email/i)).toBeVisible()
  await page.goto(latestMailLink(email, '/auth/magic'))
  return page
}

test('sign up, create an organisation, invite a colleague, connect GitHub', async ({ browser }) => {
  const admin = await signIn(browser, 'founder@example.com')
  await expect(admin).toHaveURL(/\/orgs\/new/)
  await admin.getByLabel(/^name/i).fill('Velvet')
  await admin.getByRole('button', { name: /create organisation/i }).click()
  await expect(admin).toHaveURL(/\/w\/velvet$/)

  await admin.goto('/w/velvet/admin')
  await admin.getByLabel(/email/i).fill('colleague@example.com')
  await admin.getByRole('button', { name: /send invite/i }).click()
  await expect(admin.getByText('colleague@example.com')).toBeVisible()

  // The colleague opens the invite signed out, gets a magic link, and lands inside.
  const colleagueCtx = await browser.newContext()
  const colleague = await colleagueCtx.newPage()
  await colleague.goto(latestMailLink('colleague@example.com', '/invite/'))
  await expect(colleague.getByText(/invited you to Velvet/)).toBeVisible()
  await colleague.getByRole('button', { name: /sign in and accept/i }).click()
  await expect(colleague.getByText(/check your email/i)).toBeVisible()
  await colleague.goto(latestMailLink('colleague@example.com', '/auth/magic'))
  await expect(colleague).toHaveURL(/\/w\/velvet$/)
  await colleague.goto('/w/velvet/admin')
  await expect(colleague.getByText(/administration/i)).not.toBeVisible()

  // Admin connects GitHub. The redirect to github.com is intercepted and the
  // stubbed installation is sent straight back to the setup callback.
  await admin.goto('/w/velvet/admin')
  const [connect] = await Promise.all([
    admin.waitForRequest((r) => r.url().includes('/github/connect')),
    admin.getByRole('link', { name: /connect github/i }).click(),
  ])
  const location = (await connect.response())!.headers()['location']
  const state = new URL(location).searchParams.get('state')!
  await admin.goto(`/api/v1/github/setup?installation_id=777&setup_action=install&state=${encodeURIComponent(state)}`)
  await expect(admin).toHaveURL(/\/w\/velvet\/admin$/)
  await expect(admin.getByText('acme/a')).toBeVisible()

  // The repository row exists with the right installation for webhooks.
  expect(sql(`SELECT installation_id FROM repo WHERE name = 'a'`)).toBe('777')
})

test('a used sign-in link shows the expired page', async ({ browser }) => {
  const page = await signIn(browser, 'again@example.com')
  await page.goto(latestMailLink('again@example.com', '/auth/magic'))
  await expect(page).toHaveURL(/\/expired/)
})
```

Playwright follows the 302 from `/github/connect` to github.com, which is off-network in CI. Set `page.route('https://github.com/**', (route) => route.fulfill({ status: 204 }))` on the admin page before clicking so the navigation ends harmlessly, and read the state from the intercepted response as above.

The existing evidence test then proves the webhook path end to end, since `seedRepo` binds the installation the same way. Run `resetWorkspaceData()` between suites as today.

- [ ] **Step 4: Run the suite locally**

Run: `cd e2e && npx playwright test`
Expected: PASS for all specs. If the stack fails to start, `./stack-down.sh` and read `docker compose logs api` for the migration guard message: a leftover volume with old users breaks 0006, and `docker compose down -v` clears it.

- [ ] **Step 5: Commit**

```bash
git add e2e deploy/docker-compose.yml
git commit -m "Prove the onboarding journey end to end: sign up, invite, connect GitHub"
```

---

### Task 16: Deployment settings and documentation

**Files:**
- Modify: `deploy/docker-compose.yml`, `README.md`, `docs/superpowers/specs/2026-09-07-saas-organisations-design.md`
- Requires the operator: `deploy/.env.example` lines, the GitHub App settings, the existing user's email.

- [ ] **Step 1: Pass the new settings through Compose**

In the `api` service environment add:

```yaml
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      MAIL_FROM: ${MAIL_FROM:-}
      GITHUB_APP_SLUG: ${GITHUB_APP_SLUG:-}
```

The worker does not send mail and does not need them.

- [ ] **Step 2: Rewrite the README setup**

Replace the "First workspace and invites" section and every mention of `bootstrap.sh`, `invite.sh`, `connect-repo.sh`, and "not invited" with:

- Sign-in: "Sign in with your email; a link arrives and works once. There are no passwords."
- First organisation: "After signing in, create an organisation. You are its admin. Invite others from the Administration page; they receive an email."
- GitHub: "From the Administration page click Connect GitHub, install the App on your account or organisation, and pick repositories. They connect on return, and stay in sync when you change the installation on GitHub. Uninstall the App to disconnect."
- Profile: "Link your GitHub account from your profile so pull requests you author show under your name."

Update the environment table with `RESEND_API_KEY` (for sign-in and invites, required in production), `MAIL_FROM`, and `GITHUB_APP_SLUG`. In the GitHub App steps add: set the App to "Any account" and the Setup URL to `https://YOUR_HOST/api/v1/github/setup` with "Redirect on update" ticked. State that the OAuth App is now only used for linking accounts and its callback URL is unchanged.

Add an "Upgrading an existing installation" paragraph: set every existing user's email with `UPDATE app_user SET email = '...' WHERE github_login = '...'` and delete unclaimed invites with `DELETE FROM membership WHERE user_id IS NULL` before deploying, because the migration refuses to run otherwise.

- [ ] **Step 3: Note the two migration files in the spec**

In the spec's section 7, replace "One migration:" with "Two migration files, applied in order: `0005_organisations.sql` adds columns and tables, `0006_email_identity.sql` tightens constraints and drops `invited_login` once nothing reads it." Also in section 10 change the magic endpoint limit sentence to: "The email form is limited to 5 requests per address and 20 per IP in 15 minutes, enforced in Postgres so it holds across restarts; the magic endpoint relies on 256-bit single-use tokens rather than a counter."

- [ ] **Step 4: Ask the operator for `.env.example`**

The file matches the `.env*` rule and is not edited without asking. Request adding these three lines, names only:

```
RESEND_API_KEY=
MAIL_FROM=
GITHUB_APP_SLUG=
```

- [ ] **Step 5: Run the full local gate**

Run: `cd api && go test -count=1 ./... && cd ../web && npx tsc --noEmit && npx vitest run && npm run build && cd ../e2e && npx playwright test`
Expected: PASS everywhere.

- [ ] **Step 6: Commit and open the pull request**

```bash
git add deploy README.md docs
git commit -m "Document self-serve organisations and pass the mail settings through Compose"
git push -u origin t3code/saas-organisations
gh pr create --base main --title "Self-serve organisations: email sign-in, invitations, GitHub as an integration"
```

Before merging, the operator does, in this order: creates the Resend account and verifies `mail.velvet.sabarinarayana.com`; adds `RESEND_API_KEY`, `MAIL_FROM`, and `GITHUB_APP_SLUG=velvet-worklog` to the host's `.env.local`; sets the existing admin user's email on the host database; switches the GitHub App to "Any account" with the setup URL. Merging then deploys through the existing pipeline, and the migration refuses to run if the email step was skipped.
