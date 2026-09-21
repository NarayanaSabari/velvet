package testutil

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

// The GitHub identifiers the fixtures and the webhook payload fixtures agree
// on, so a stub, a payload, and a database row all describe one repository.
const (
	testInstallationID  = 99
	defaultRepoGitHubID = 555
	foreignRepoGitHubID = 556
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

// CreateLinkedUser creates an email account with optional GitHub profile data.
// Tests never use GitHub identity to claim membership or establish a session.
func CreateLinkedUser(t *testing.T, st *store.Store, gh store.GitHubIdentity) (store.User, error) {
	t.Helper()
	user, err := st.UpsertUserByEmail(t.Context(), gh.Login+"@example.com")
	if err != nil {
		return user, err
	}
	err = st.Pool().QueryRow(t.Context(), `UPDATE app_user SET github_id=$1,github_login=$2,name=$3,avatar_url=$4 WHERE id=$5 RETURNING id,email,github_id,github_login,name,avatar_url`, gh.ID, gh.Login, gh.Name, gh.AvatarURL, user.ID).Scan(&user.ID, &user.Email, &user.GitHubID, &user.GitHubLogin, &user.Name, &user.AvatarURL)
	return user, err
}

// NewFixture gives a test a migrated database, one workspace, one signed-in
// admin, and a ready HTTP handler.
func NewFixture(t *testing.T) *Fixture {
	t.Helper()
	return NewFixtureWithWebhookSecret(t, "")
}

// NewFixtureWithWebhookSecret is NewFixture with the GitHub webhook secret
// configured, for the tests that sign a delivery. There is one construction
// path so a fixture cannot drift from the server the other tests exercise.
func NewFixtureWithWebhookSecret(t *testing.T, secret string) *Fixture {
	t.Helper()
	pool := NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Lab', 'lab', 'ENG')
		 RETURNING id`).Scan(&wsID))

	user, err := CreateLinkedUser(t, st, store.GitHubIdentity{
		ID: 1001, Login: "sabari", Name: "Sabari"})
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role)
		 VALUES ($1, $2, 'admin')`, wsID, user.ID)
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, user.ID, time.Hour)
	require.NoError(t, err)

	cfg := &config.Config{BaseURL: "http://localhost:8080",
		GitHubWebhookSecret: secret}

	return &Fixture{
		T: t, Pool: pool, Store: st,
		Handler:     api.NewServer(pool, cfg, api.Dependencies{}).Handler(),
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
	req.Header.Set("Origin", "http://localhost:8080")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// DoAsAgent issues a request authenticated with a personal API token rather
// than a browser cookie, which is how a coding agent reaches the API. The
// Origin header is deliberately absent: bearer requests are not browser
// requests and must not need one.
func (f *Fixture) DoAsAgent(method, path, token string, body any) *httptest.ResponseRecorder {
	f.T.Helper()
	var buf bytes.Buffer
	if body != nil {
		require.NoError(f.T, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// AgentToken mints a personal API token, returning the one-time secret an
// agent would be configured with.
func (f *Fixture) AgentToken(name string) string {
	f.T.Helper()
	raw, err := f.Store.CreateAPIToken(f.T.Context(), f.User.ID, name)
	require.NoError(f.T, err)
	return raw
}

// DecodeInto unmarshals a recorder body, failing the test on bad JSON.
func (f *Fixture) DecodeInto(rec *httptest.ResponseRecorder, dst any) {
	f.T.Helper()
	require.NoError(f.T, json.Unmarshal(rec.Body.Bytes(), dst), "body: %s", rec.Body.String())
}

// CreateIssue makes an issue through the store, so it gets a real key from the
// same allocator the API uses.
func CreateIssue(t *testing.T, f *Fixture, title string) store.Issue {
	t.Helper()
	issue, err := f.Store.CreateIssue(t.Context(), store.CreateIssueInput{
		WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Title: title})
	require.NoError(t, err)
	return issue
}

// CreateForeignProject makes a project in a different workspace, so a test can
// prove that a valid UUID from elsewhere cannot be referenced here.
func CreateForeignProject(t *testing.T, f *Fixture, key string) uuid.UUID {
	t.Helper()
	ctx := t.Context()

	var otherWS uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix)
		 VALUES ('Foreign projects', 'foreign-projects', 'FPR') RETURNING id`).Scan(&otherWS))

	project, err := f.Store.CreateProject(ctx, store.CreateProjectInput{
		WorkspaceID: otherWS, Key: key, Name: "Foreign"})
	require.NoError(t, err)
	return project.ID
}

// LinkRepo seeds a verified active binding under installation 99, which is the
// installation the GitHub stubs answer for. Legacy tests seed unverified rows
// explicitly so evidence tests exercise the same gates as owner-authorized use.
func LinkRepo(t *testing.T, f *Fixture, githubID int64, owner, name string) store.Repo {
	t.Helper()
	repo, err := f.Store.LinkRepo(t.Context(), store.LinkRepoInput{
		WorkspaceID: f.WorkspaceID, InstallationID: testInstallationID,
		GitHubID: githubID, Owner: owner, Name: name})
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `UPDATE github_installation SET workspace_id=$1,ownership_verified_at=now(),repos_synced_at=now() WHERE id=$2`, f.WorkspaceID, testInstallationID)
	require.NoError(t, err)
	return repo
}

// InsertPullRequest stores a PR directly, for tests about what happens after
// one exists rather than about how it got there.
func InsertPullRequest(t *testing.T, f *Fixture, number int, title, state string) store.PullRequest {
	t.Helper()
	repo := LinkRepo(t, f, defaultRepoGitHubID, "acme", "widgets")
	now := time.Now().UTC()
	pr, err := f.Store.UpsertPullRequest(t.Context(), store.UpsertPRInput{
		WorkspaceID: f.WorkspaceID, RepoID: repo.ID, Number: number,
		Title: title, State: state, AuthorLogin: "sabari",
		HTMLURL:     "https://github.com/acme/widgets/pull/" + strconv.Itoa(number),
		GHCreatedAt: &now, GHUpdatedAt: &now})
	require.NoError(t, err)
	return pr
}

// InsertForeignPullRequest stores a PR in a different workspace, so a test can
// prove that a valid UUID from elsewhere cannot be attached here.
func InsertForeignPullRequest(t *testing.T, f *Fixture, number int, title string) uuid.UUID {
	t.Helper()
	ctx := t.Context()

	var otherWS uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix)
		 VALUES ('Foreign', 'foreign', 'FOR') RETURNING id`).Scan(&otherWS))

	repo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: otherWS, InstallationID: testInstallationID,
		GitHubID: foreignRepoGitHubID, Owner: "other", Name: "repo"})
	require.NoError(t, err)

	now := time.Now().UTC()
	pr, err := f.Store.UpsertPullRequest(ctx, store.UpsertPRInput{
		WorkspaceID: otherWS, RepoID: repo.ID, Number: number,
		Title: title, State: "open", GHCreatedAt: &now, GHUpdatedAt: &now})
	require.NoError(t, err)
	return pr.ID
}

// NewWorker builds a worker whose GitHub client points at a stub, using an
// RSA key generated in this process. Generating beats committing: nothing
// secret ever reaches the repository.
func NewWorker(t *testing.T, f *Fixture, stub *httptest.Server) *worker.Worker {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})

	client, err := github.NewClient("123", pemBytes, stub.URL)
	require.NoError(t, err)
	return worker.New(f.Store, client)
}
