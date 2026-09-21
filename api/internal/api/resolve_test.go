package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func resolveRemote(t *testing.T, f *testutil.Fixture, remote string) (*http.Response, store.RepoResolution) {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/me/resolve-repo", map[string]any{"remote": remote})
	var resolved store.RepoResolution
	if rec.Code == http.StatusOK {
		f.DecodeInto(rec, &resolved)
	}
	return rec.Result(), resolved
}

// One configuration in every checkout: the agent asks where it is rather than
// being told separately for each repository.
func TestResolveRepoNamesTheOrganisationAndProject(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	require.NoError(t, f.Store.SetRepoProject(t.Context(), f.WorkspaceID, repo.ID, f.User.ID, &project.ID))

	for _, remote := range []string{
		"git@github.com:acme/widgets.git",
		"https://github.com/acme/widgets",
		"ssh://git@github.com/acme/widgets.git",
		"ACME/WIDGETS",
	} {
		res, resolved := resolveRemote(t, f, remote)
		require.Equal(t, http.StatusOK, res.StatusCode, remote)
		require.Equal(t, "lab", resolved.WorkspaceSlug, remote)
		require.Equal(t, "ENG", resolved.IssuePrefix, remote)
		require.NotNil(t, resolved.ProjectKey, remote)
		require.Equal(t, "velvet", *resolved.ProjectKey, remote)
	}
}

// A repository with no project still resolves its organisation, because
// knowing where to log is more important than having filed it under a goal.
func TestResolveRepoWorksWithoutAProject(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	res, resolved := resolveRemote(t, f, "git@github.com:acme/widgets.git")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "lab", resolved.WorkspaceSlug)
	require.Nil(t, resolved.ProjectKey)
}

// Writing an entry into the wrong client's organisation is worse than being
// told the checkout is unrecognised.
func TestResolveRepoRefusesWhatItCannotPlace(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.LinkRepo(t, f, 555, "acme", "widgets")

	for _, remote := range []string{
		"git@github.com:someone/else.git",
		"https://github.com/acme/other",
		"not a remote",
	} {
		res, _ := resolveRemote(t, f, remote)
		require.Equal(t, http.StatusNotFound, res.StatusCode, remote)
	}

	rec := f.Do(http.MethodPost, "/api/v1/me/resolve-repo", map[string]any{"remote": ""})
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// A repository connected to another organisation this person does not belong
// to must not resolve, or an agent could log into a stranger's record.
func TestResolveRepoOnlyConsidersTheCallersOrganisations(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	var strangerWS string
	require.NoError(t, f.Pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix)
		 VALUES ('Stranger', 'stranger', 'STR') RETURNING id`).Scan(&strangerWS))
	_, err := f.Pool.Exec(ctx,
		`INSERT INTO github_installation (id, account_login) VALUES (123, 'stranger')`)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `
		INSERT INTO repo (workspace_id, installation_id, github_id, owner, name)
		VALUES ($1::uuid, 123, 999, 'stranger', 'private')`, strangerWS)
	require.NoError(t, err)

	res, _ := resolveRemote(t, f, "git@github.com:stranger/private.git")
	require.Equal(t, http.StatusNotFound, res.StatusCode,
		"a repository in an organisation I do not belong to must not resolve")
}

// The same repository in two of the caller's organisations has no single right
// answer, so the caller is asked to be explicit rather than given one.
func TestResolveRepoReportsAnAmbiguousMatch(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()

	testutil.LinkRepo(t, f, 555, "acme", "widgets")
	clientWS := secondOrg(t, f, "client")
	_, err := f.Pool.Exec(ctx,
		`INSERT INTO github_installation (id, account_login) VALUES (124, 'acme')`)
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `
		INSERT INTO repo (workspace_id, installation_id, github_id, owner, name)
		VALUES ($1, 124, 998, 'acme', 'widgets')`, clientWS)
	require.NoError(t, err)

	res, _ := resolveRemote(t, f, "git@github.com:acme/widgets.git")
	require.Equal(t, http.StatusConflict, res.StatusCode)
}

func TestResolveRepoIsReachableByAnAgentToken(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.LinkRepo(t, f, 555, "acme", "widgets")
	token := f.AgentToken("coding agent")

	rec := f.DoAsAgent(http.MethodPost, "/api/v1/me/resolve-repo", token,
		map[string]any{"remote": "git@github.com:acme/widgets.git"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var resolved store.RepoResolution
	f.DecodeInto(rec, &resolved)
	require.Equal(t, "lab", resolved.WorkspaceSlug)
}
