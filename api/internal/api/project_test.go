package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func createProject(t *testing.T, f *testutil.Fixture, body map[string]any) store.Project {
	t.Helper()
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects", body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var p store.Project
	f.DecodeInto(rec, &p)
	return p
}

func TestCreatingAProjectRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})

	require.Equal(t, "velvet", project.Key)
	require.Equal(t, "active", project.Status, "a new project is active")
	require.Nil(t, project.ArchivedAt)

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 AND target_type = 'project'`,
		project.ID).Scan(&verb))
	require.Equal(t, store.VerbCreatedProject, verb)
}

func TestProjectKeysNormalizeAndMustBeUniquePerWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "Velvet", "name": "Velvet"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects",
		map[string]any{"key": "velvet", "name": "Duplicate"})
	require.Equal(t, http.StatusConflict, rec.Code, "a normalized key collides")

	// The stored key is lowercase, so a mixed-case path still resolves.
	for _, key := range []string{"velvet", "VELVET", "Velvet"} {
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/projects/"+key, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
}

func TestProjectKeyIsValidatedBeforeReachingTheDatabase(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, key := range []string{"", "-leading", "trailing-", "has space", "has_underscore"} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects",
			map[string]any{"key": key, "name": "Bad"})
		require.Equal(t, http.StatusBadRequest, rec.Code,
			"key %q must be a client error, not a constraint violation", key)
	}
}

func TestArchivingAProjectSetsItsTimestampAndHidesItByDefault(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/projects/velvet",
		map[string]any{"status": "archived"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var archived store.Project
	f.DecodeInto(rec, &archived)
	require.Equal(t, "archived", archived.Status)
	require.NotNil(t, archived.ArchivedAt, "archiving must record when it happened")

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/projects", nil)
	var list struct {
		Projects []store.Project `json:"projects"`
	}
	f.DecodeInto(rec, &list)
	require.Empty(t, list.Projects, "an archived project is hidden by default")

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/projects?include_archived=true", nil)
	f.DecodeInto(rec, &list)
	require.Len(t, list.Projects, 1)

	// Un-archiving must clear the timestamp, or the pairing constraint would
	// leave a live project claiming to have been archived.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/projects/velvet",
		map[string]any{"status": "active"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var restored store.Project
	f.DecodeInto(rec, &restored)
	require.Equal(t, "active", restored.Status)
	require.Nil(t, restored.ArchivedAt)
	require.Equal(t, project.ID, restored.ID)
}

func TestUpdatingAProjectRecordsOneActivityPerRealChange(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})

	// Re-sending the same name must not manufacture a feed entry.
	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/projects/velvet",
		map[string]any{"name": "Velvet"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var updates int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1`, store.VerbUpdatedProject).Scan(&updates))
	require.Zero(t, updates, "an unchanged value must not record activity")

	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/projects/velvet",
		map[string]any{"name": "Velvet Worklog"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1`, store.VerbUpdatedProject).Scan(&updates))
	require.Equal(t, 1, updates)
}

func TestIssuesFilterByProjectAndStayWorkspaceScoped(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	createProject(t, f, map[string]any{"key": "other", "name": "Other"})

	filed := createIssue(t, f, map[string]any{"title": "Filed", "project": "velvet"})
	require.NotNil(t, filed.ProjectID)
	require.Equal(t, project.ID, *filed.ProjectID)

	// Unfiled work must remain possible, which is the whole reason the column
	// is nullable.
	unfiled := createIssue(t, f, map[string]any{"title": "Unfiled"})
	require.Nil(t, unfiled.ProjectID)

	listIssues := func(query string) []store.Issue {
		rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues"+query, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			Issues []store.Issue `json:"issues"`
		}
		f.DecodeInto(rec, &body)
		return body.Issues
	}

	byKey := listIssues("?project=velvet")
	require.Len(t, byKey, 1)
	require.Equal(t, filed.ID, byKey[0].ID)

	byID := listIssues("?project_id=" + project.ID.String())
	require.Len(t, byID, 1)
	require.Equal(t, filed.ID, byID[0].ID)

	require.Empty(t, listIssues("?project=other"))
	require.Len(t, listIssues(""), 2, "an unfiltered list still shows unfiled work")
}

func TestIssueCannotReferenceAProjectFromAnotherWorkspace(t *testing.T) {
	f := testutil.NewFixture(t)
	foreign := testutil.CreateForeignProject(t, f, "foreign")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues",
		map[string]any{"title": "Smuggled", "project_id": foreign.String()})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"a valid UUID from another workspace must not be usable here")

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/projects/foreign", nil)
	require.Equal(t, http.StatusNotFound, rec.Code,
		"another workspace's project key must not resolve here")
}

func TestMovingAnIssueBetweenProjectsRecordsActivity(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"project": "velvet"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var moved store.Issue
	f.DecodeInto(rec, &moved)
	require.NotNil(t, moved.ProjectID)

	var moves int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM activity WHERE verb = $1 AND target_id = $2`,
		store.VerbMovedIssueProject, issue.ID).Scan(&moves))
	require.Equal(t, 1, moves)

	// An explicit empty key detaches the issue rather than failing to resolve.
	rec = f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
		map[string]any{"project": ""})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var detached store.Issue
	f.DecodeInto(rec, &detached)
	require.Nil(t, detached.ProjectID)
}

func TestProjectListReportsIssueCountsPerStatus(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	createProject(t, f, map[string]any{"key": "empty", "name": "Empty"})

	createIssue(t, f, map[string]any{"title": "One", "project": "velvet"})
	createIssue(t, f, map[string]any{"title": "Two", "project": "velvet", "status": "in_progress"})

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/projects", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Projects []store.Project `json:"projects"`
	}
	f.DecodeInto(rec, &body)
	require.Len(t, body.Projects, 2)

	counts := map[string]map[string]int{}
	for _, p := range body.Projects {
		counts[p.Key] = p.IssueCounts
	}
	require.Equal(t, map[string]int{"backlog": 1, "in_progress": 1}, counts["velvet"])
	require.Empty(t, counts["empty"], "a project with no issues reports no counts")
}

func TestMappingARepositoryToAProjectIsWorkspaceScopedAndLogged(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")

	rec := f.Do(http.MethodPut, "/api/v1/w/lab/repos/"+repo.ID.String()+"/project",
		map[string]any{"project_id": project.ID.String()})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	var mapped string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT project_id::text FROM repo WHERE id = $1`, repo.ID).Scan(&mapped))
	require.Equal(t, project.ID.String(), mapped)

	// The repository list reports the mapping, so Administration can show it.
	listed := f.Do(http.MethodGet, "/api/v1/w/lab/repos", nil)
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var repos struct {
		Repos []store.Repo `json:"repos"`
	}
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &repos))
	require.Len(t, repos.Repos, 1)
	require.NotNil(t, repos.Repos[0].ProjectID)
	require.Equal(t, project.ID, *repos.Repos[0].ProjectID)

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE target_id = $1 AND target_type = 'repo'`,
		repo.ID).Scan(&verb))
	require.Equal(t, store.VerbMappedRepoProject, verb)

	foreign := testutil.CreateForeignProject(t, f, "foreign")
	rec = f.Do(http.MethodPut, "/api/v1/w/lab/repos/"+repo.ID.String()+"/project",
		map[string]any{"project_id": foreign.String()})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"a project from another workspace must not be mappable here")

	rec = f.Do(http.MethodPut, "/api/v1/w/lab/repos/"+repo.ID.String()+"/project",
		map[string]any{"project_id": nil})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	var cleared *string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT project_id::text FROM repo WHERE id = $1`, repo.ID).Scan(&cleared))
	require.Nil(t, cleared)
}

func TestDeletingAProjectLeavesItsIssuesUnfiled(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	issue := createIssue(t, f, map[string]any{"title": "Survivor", "project": "velvet"})

	_, err := f.Pool.Exec(t.Context(), `DELETE FROM project WHERE id = $1`, project.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key, nil)
	require.Equal(t, http.StatusOK, rec.Code, "deleting a project must not delete its work")
	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Nil(t, got.ProjectID)
}
