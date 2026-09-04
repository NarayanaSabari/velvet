package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// Every timestamp the API emits must be valid ISO 8601 with a full offset.
// Postgres's plain OF pattern renders "+00", which JavaScript's Date parser
// rejects, so the browser silently fell back to printing the raw string
// instead of "3 hours ago". The Go tests could not see it because they never
// parsed a timestamp the way a browser does.
func TestEmittedTimestampsAreParseableAsISO8601(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))

	sprint, err := st.CreateSprint(ctx, store.CreateSprintInput{
		WorkspaceID: uuidMust(t, wsID),
		Name:        "September",
		StartsOn:    "2026-09-01",
		EndsOn:      "2026-09-30",
	})
	require.NoError(t, err)

	// time.RFC3339 is exactly what a browser's Date parser accepts, so parsing
	// with it is the same check the UI performs.
	_, err = time.Parse(time.RFC3339, sprint.CreatedAt)
	require.NoError(t, err,
		"created_at %q must parse as RFC3339; a bare +00 offset breaks the browser",
		sprint.CreatedAt)
}

func uuidMust(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	require.NoError(t, err)
	return id
}

// GitHub logins are case-insensitive and the schema indexes on lower(), but
// the PR upsert compared exactly. A PR opened by "Sabari" therefore resolved
// to no member and the work went uncredited.
func TestPullRequestAuthorResolvesCaseInsensitively(t *testing.T) {
	pool := testutil.NewPostgres(t)
	st := store.New(pool)
	ctx := context.Background()

	var wsID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ('Lab', 'lab') RETURNING id`).Scan(&wsID))

	user, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{ID: 1, Login: "sabari"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'sabari', 'member')`, wsID, user.ID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `INSERT INTO github_installation (id, account_login) VALUES (99, 'acme')`)
	require.NoError(t, err)
	var repoID string
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO repo (workspace_id, installation_id, github_id, owner, name)
		VALUES ($1, 99, 555, 'acme', 'widgets') RETURNING id`, wsID).Scan(&repoID))

	// GitHub sends the login with its original casing.
	pr, err := st.UpsertPullRequest(ctx, store.UpsertPRInput{
		WorkspaceID: uuidMust(t, wsID),
		RepoID:      uuidMust(t, repoID),
		Number:      1,
		Title:       "Fix auth",
		State:       "open",
		AuthorLogin: "Sabari",
		GHUpdatedAt: timePtr(time.Now()),
	})
	require.NoError(t, err)
	require.NotNil(t, pr.AuthorID,
		"a differently-cased login must still resolve to the member")
	require.Equal(t, user.ID, *pr.AuthorID)
}

func timePtr(t time.Time) *time.Time { return &t }
