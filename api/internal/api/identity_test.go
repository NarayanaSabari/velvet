package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// secondOrg gives the fixture's user a membership in another organisation, the
// way someone working for several clients actually is.
func secondOrg(t *testing.T, f *testutil.Fixture, slug string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug, issue_prefix)
		 VALUES ($1, $1, 'CLI') RETURNING id`, slug).Scan(&id))
	_, err := f.Pool.Exec(t.Context(),
		`INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
		id, f.User.ID)
	require.NoError(t, err)
	return id
}

func insertPR(t *testing.T, f *testutil.Fixture, workspaceID, repoID uuid.UUID, number int, login string) store.PullRequest {
	t.Helper()
	now := time.Now().UTC()
	pr, err := f.Store.UpsertPullRequest(t.Context(), store.UpsertPRInput{
		WorkspaceID: workspaceID, RepoID: repoID, Number: number,
		Title: "Client work", State: "open", AuthorLogin: login,
		GHCreatedAt: &now, GHUpdatedAt: &now})
	require.NoError(t, err)
	return pr
}

// Sabari uses a different GitHub account for each client organisation. Before
// per-organisation identity, app_user held exactly one github_login and PR
// authorship matched that single login, so at most one organisation could ever
// recognise his work.
func TestEachOrganisationAttributesItsOwnGitHubAccount(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	clientRepo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: clientWS, InstallationID: 99, GitHubID: 777,
		Owner: "client", Name: "app"})
	require.NoError(t, err)

	// In the client organisation he pushes as "sabari-client", which is not
	// the login on his global profile.
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))

	pr := insertPR(t, f, clientWS, clientRepo.ID, 1, "sabari-client")
	require.NotNil(t, pr.AuthorID, "the client-org account must attribute his work")
	require.Equal(t, f.User.ID, *pr.AuthorID)

	// The home organisation still attributes his global account, so the two
	// identities coexist rather than one replacing the other.
	homeRepo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	home := insertPR(t, f, f.WorkspaceID, homeRepo.ID, 1, "sabari")
	require.NotNil(t, home.AuthorID)
	require.Equal(t, f.User.ID, *home.AuthorID)
}

// Evidence usually arrives before anyone links an account, so linking must
// claim the work already recorded under that login.
func TestLinkingAnIdentityReattributesExistingEvidence(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	repo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: clientWS, InstallationID: 99, GitHubID: 777,
		Owner: "client", Name: "app"})
	require.NoError(t, err)

	pr := insertPR(t, f, clientWS, repo.ID, 1, "sabari-client")
	require.Nil(t, pr.AuthorID, "before linking, nobody owns this work")

	require.NoError(t, f.Store.UpsertReview(ctx, store.UpsertReviewInput{
		WorkspaceID: clientWS, PullRequestID: pr.ID, GitHubID: 5001,
		ReviewerLogin: "sabari-client", State: "APPROVED", SubmittedAt: time.Now().UTC()}))

	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))

	var authorID, reviewerID *uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT author_id FROM pull_request WHERE id = $1`, pr.ID).Scan(&authorID))
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT reviewer_id FROM pr_review WHERE github_id = 5001`).Scan(&reviewerID))
	require.NotNil(t, authorID, "linking must claim work already recorded")
	require.Equal(t, f.User.ID, *authorID)
	require.NotNil(t, reviewerID)
	require.Equal(t, f.User.ID, *reviewerID)

	var verb string
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT verb FROM activity WHERE workspace_id = $1 AND verb = $2`,
		clientWS, store.VerbLinkedGitHubIdentity).Scan(&verb))
	require.Equal(t, store.VerbLinkedGitHubIdentity, verb)
}

// Attribution that worked before this table existed must keep working, since
// most people use one GitHub account everywhere.
func TestGlobalGitHubLoginStillAttributesWithoutAPerOrgIdentity(t *testing.T) {
	f := testutil.NewFixture(t)

	_, err := f.Pool.Exec(t.Context(), `DELETE FROM membership_github_identity`)
	require.NoError(t, err)

	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	pr := insertPR(t, f, f.WorkspaceID, repo.ID, 1, "sabari")
	require.NotNil(t, pr.AuthorID, "the global login remains a fallback")
	require.Equal(t, f.User.ID, *pr.AuthorID)
}

func TestAGitHubAccountCannotBeClaimedTwiceInOneOrganisation(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	colleague, err := testutil.CreateLinkedUser(t, f.Store,
		store.GitHubIdentity{ID: 3003, Login: "colleague"})
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
		f.WorkspaceID, colleague.ID)
	require.NoError(t, err)

	shared := store.GitHubIdentity{ID: 4004, Login: "shared-account"}
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID, shared))

	err = f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, colleague.ID, shared)
	require.ErrorIs(t, err, store.ErrDuplicate,
		"two people claiming one account would make attribution ambiguous")

	// The same account in a different organisation is fine: that is the whole
	// point of per-organisation identity.
	clientWS := secondOrg(t, f, "client")
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID, shared))
}

func TestUnlinkingAnIdentityKeepsTheEvidenceItAttributed(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	clientWS := secondOrg(t, f, "client")
	repo, err := f.Store.LinkRepo(ctx, store.LinkRepoInput{
		WorkspaceID: clientWS, InstallationID: 99, GitHubID: 777,
		Owner: "client", Name: "app"})
	require.NoError(t, err)

	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))
	pr := insertPR(t, f, clientWS, repo.ID, 1, "sabari-client")
	require.NotNil(t, pr.AuthorID)

	require.NoError(t, f.Store.UnlinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID))

	// Work that happened still happened.
	var authorID *uuid.UUID
	require.NoError(t, f.Pool.QueryRow(ctx,
		`SELECT author_id FROM pull_request WHERE id = $1`, pr.ID).Scan(&authorID))
	require.NotNil(t, authorID, "unlinking must not erase the record of past work")
	require.Equal(t, f.User.ID, *authorID)

	require.ErrorIs(t, f.Store.UnlinkMembershipGitHubIdentity(ctx, clientWS, f.User.ID),
		store.ErrNotFound)
}

func TestWorkspaceGitHubIdentityEndpointReportsTheAttributingAccount(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	// With no organisation-specific account, the endpoint reports the global
	// profile, because that is the account actually attributing work here.
	rec := f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Identity *store.MembershipGitHubIdentity `json:"identity"`
	}
	f.DecodeInto(rec, &body)
	require.NotNil(t, body.Identity)
	require.Equal(t, "sabari", body.Identity.GitHubLogin)

	// Linking an organisation-specific account takes precedence.
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "sabari-client"}))
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	f.DecodeInto(rec, &body)
	require.NotNil(t, body.Identity)
	require.Equal(t, "sabari-client", body.Identity.GitHubLogin)

	// Unlinking falls back to the global profile rather than reporting none.
	rec = f.Do(http.MethodDelete, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	f.DecodeInto(rec, &body)
	require.NotNil(t, body.Identity)
	require.Equal(t, "sabari", body.Identity.GitHubLogin)

	// Someone with no GitHub account anywhere genuinely has no identity, which
	// is an ordinary state rather than a failure.
	_, err := f.Pool.Exec(ctx,
		`UPDATE app_user SET github_id = NULL, github_login = NULL WHERE id = $1`, f.User.ID)
	require.NoError(t, err)
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	f.DecodeInto(rec, &body)
	require.Nil(t, body.Identity)
}
