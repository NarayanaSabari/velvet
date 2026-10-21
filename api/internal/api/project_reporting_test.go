package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestSprintPersonTotalsOnlyCountItsProject(t *testing.T) {
	f := testutil.NewFixture(t)
	day := time.Now().UTC().Format("2006-01-02")
	sprints := []store.Sprint{}
	targets := []store.ActivityInput{}
	for index, key := range []string{"web", "api"} {
		project := createProject(t, f, map[string]any{"key": key, "name": key})
		sprint := sprintFor(t, f, project, "Today", day, day)
		sprints = append(sprints, sprint)
		goal := milestoneIn(t, f, sprint, "Goal")
		issue := createIssue(t, f, map[string]any{"title": key, "milestone_id": goal.ID.String()})
		repo := testutil.LinkRepo(t, f, int64(555+index), "acme", key)
		require.NoError(t, f.Store.SetRepoProject(t.Context(), f.WorkspaceID, repo.ID, f.User.ID, &project.ID))
		for _, target := range []struct {
			kind string
			id   uuid.UUID
		}{{"issue", issue.ID}, {"milestone", goal.ID}, {"project", project.ID}, {"sprint", sprint.ID}, {"repo", repo.ID}} {
			targets = append(targets, store.ActivityInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Verb: "audit_probe", TargetType: target.kind, TargetID: target.id})
			if target.kind == "sprint" || target.kind == "repo" {
				continue
			}
			comment, err := f.Store.CreateComment(t.Context(), store.CreateCommentInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: target.kind, TargetID: target.id, Body: "Update"})
			require.NoError(t, err)
			targets = append(targets, store.ActivityInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Verb: store.VerbCommented, TargetType: "comment", TargetID: comment.ID})
		}
	}
	_, err := f.Pool.Exec(t.Context(), `UPDATE activity SET created_at='2000-01-01'`)
	require.NoError(t, err)
	require.NoError(t, f.Store.InTx(t.Context(), func(tx pgx.Tx) error {
		for _, target := range targets {
			if err := store.RecordActivity(t.Context(), tx, target); err != nil {
				return err
			}
		}
		return store.RecordActivity(t.Context(), tx, store.ActivityInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, Verb: "unrelated", TargetType: "workspace", TargetID: f.WorkspaceID})
	}))
	for _, sprint := range sprints {
		_, err := f.Store.CloseSprint(t.Context(), f.WorkspaceID, sprint.ID, f.User.ID)
		require.NoError(t, err)
		snapshot, err := f.Store.GetSnapshot(t.Context(), f.WorkspaceID, sprint.ID)
		require.NoError(t, err)
		require.Equal(t, map[string]int{"sabari": 8}, snapshot.PersonTotals)
	}
}

func TestMilestoneNotesAppearInProjectAndScopedRecaps(t *testing.T) {
	s := newScopedSetup(t)
	project, err := s.f.Store.GetProjectByKey(t.Context(), s.f.WorkspaceID, "own")
	require.NoError(t, err)
	sprint := sprintFor(t, s.f, project, "Sprint", "2026-09-01", "2026-09-30")
	goal := milestoneIn(t, s.f, sprint, "Goal")
	require.Equal(t, http.StatusCreated, s.f.Do(http.MethodPost, "/api/v1/w/lab/milestones/"+goal.ID.String()+"/comments", map[string]string{"body": "Milestone work note"}).Code)
	for _, path := range []string{"/api/v1/me/worklog", "/api/v1/me/worklog?workspace=lab&project=own"} {
		for _, token := range []string{"", s.key} {
			var entries struct {
				Entries []store.WorklogEntry `json:"entries"`
			}
			rec := s.f.Do(http.MethodGet, path, nil)
			if token != "" {
				rec = s.as(http.MethodGet, path, nil)
			}
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			s.f.DecodeInto(rec, &entries)
			found := false
			for _, entry := range entries.Entries {
				if entry.Kind == "note" && entry.Body == "Milestone work note" {
					found = true
					require.NotNil(t, entry.ProjectKey)
					require.Equal(t, "own", *entry.ProjectKey)
					require.Equal(t, "Goal", entry.Title)
				}
			}
			require.True(t, found, path)
		}
	}
	rec := s.f.Do(http.MethodGet, "/api/v1/me/worklog?workspace=lab&project=other", nil)
	require.NotContains(t, rec.Body.String(), "Milestone work note")
}
