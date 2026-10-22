package api_test

import (
	"net/http"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestScopedMutationParity(t *testing.T) {
	s := newScopedSetup(t)
	base := "/api/v1/w/lab"
	mkSprint := func(project uuid.UUID) store.Sprint {
		sp, err := s.f.Store.CreateSprint(t.Context(), store.CreateSprintInput{WorkspaceID: s.f.WorkspaceID, ProjectID: project, ActorID: s.f.User.ID, Name: "Plan", StartsOn: "2026-11-01", EndsOn: "2026-11-30"})
		require.NoError(t, err)
		return sp
	}
	ownSprint, otherSprint := mkSprint(s.ownProject), mkSprint(s.other)
	mkMilestone := func(sp store.Sprint) store.Milestone {
		m, err := s.f.Store.CreateMilestone(t.Context(), store.CreateMilestoneInput{WorkspaceID: s.f.WorkspaceID, SprintID: sp.ID, ActorID: s.f.User.ID, Name: "Goal"})
		require.NoError(t, err)
		return m
	}
	ownMilestone, otherMilestone := mkMilestone(ownSprint), mkMilestone(otherSprint)
	mkComment := func(kind string, id uuid.UUID) store.Comment {
		c, err := s.f.Store.CreateComment(t.Context(), store.CreateCommentInput{WorkspaceID: s.f.WorkspaceID, ActorID: s.f.User.ID, TargetType: kind, TargetID: id, Body: "Original", Source: "human"})
		require.NoError(t, err)
		return c
	}
	ownComment := mkComment("issue", s.ownIssue.ID)
	otherComments := []store.Comment{mkComment("issue", s.otherIssue.ID), mkComment("milestone", otherMilestone.ID), mkComment("project", s.other), mkComment("issue", s.unfiledIssue.ID)}
	for _, c := range otherComments {
		for _, method := range []string{http.MethodPatch, http.MethodDelete} {
			rec := s.as(method, base+"/comments/"+c.ID.String(), map[string]string{"body": "Intrusion"})
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		}
	}
	for _, target := range []struct {
		path string
		body any
	}{
		{"/issues/" + s.otherIssue.Key, map[string]any{"assignee_id": s.f.User.ID}},
		{"/milestones/" + otherMilestone.ID.String(), map[string]string{"name": "Intrusion"}},
		{"/sprints/" + otherSprint.ID.String(), map[string]string{"name": "Intrusion"}},
		{"/milestones/" + ownMilestone.ID.String(), map[string]any{"after_id": otherMilestone.ID}},
		{"/issues/" + s.ownIssue.Key, map[string]any{"milestone_id": otherMilestone.ID}},
		{"/issues/" + s.ownIssue.Key, map[string]any{"project_id": s.ownProject, "project": "other"}},
	} {
		rec := s.as(http.MethodPatch, base+target.path, target.body)
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	for _, suffix := range []string{"/activate", "/close"} {
		rec := s.as(http.MethodPost, base+"/sprints/"+otherSprint.ID.String()+suffix, nil)
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	rec := s.as(http.MethodGet, base+"/sprints/"+otherSprint.ID.String()+"/snapshot", nil)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	for _, target := range []struct {
		path string
		body any
	}{
		{"/issues/" + s.ownIssue.Key, map[string]any{"title": "Edited", "assignee_id": s.f.User.ID}},
		{"/issues/" + s.ownIssue.Key, map[string]any{"assignee_id": nil}},
		{"/comments/" + ownComment.ID.String(), map[string]string{"body": "Edited"}},
		{"/milestones/" + ownMilestone.ID.String(), map[string]any{"name": "Edited", "owner_id": s.f.User.ID}},
		{"/sprints/" + ownSprint.ID.String(), map[string]string{"name": "Edited", "ends_on": "2026-12-01"}},
	} {
		rec := s.as(http.MethodPatch, base+target.path, target.body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	for _, kind := range []struct {
		kind string
		id   uuid.UUID
	}{{"project", s.ownProject}, {"milestone", ownMilestone.ID}} {
		c := mkComment(kind.kind, kind.id)
		require.Equal(t, http.StatusOK, s.as(http.MethodPatch, base+"/comments/"+c.ID.String(), map[string]string{"body": "Edited"}).Code)
		require.Equal(t, http.StatusNoContent, s.as(http.MethodDelete, base+"/comments/"+c.ID.String(), nil).Code)
	}
	require.Equal(t, http.StatusNoContent, s.as(http.MethodDelete, base+"/comments/"+ownComment.ID.String(), nil).Code)
	for _, body := range []any{map[string]string{"name": " "}, map[string]string{"starts_on": "2026-12-02"}, map[string]string{"ends_on": "2026-02-30"}, map[string]string{"project_id": s.other.String()}} {
		rec := s.as(http.MethodPatch, base+"/sprints/"+ownSprint.ID.String(), body)
		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	var actor uuid.UUID
	require.NoError(t, s.f.Pool.QueryRow(t.Context(), `SELECT actor_id FROM activity WHERE target_id=$1 AND verb='updated_sprint'`, ownSprint.ID).Scan(&actor))
	require.Equal(t, s.f.User.ID, actor)
	ownImage := imageUpload(t, s.f, base+"/issues/"+s.ownIssue.Key+"/images", "Own")
	otherImage := imageUpload(t, s.f, base+"/issues/"+s.otherIssue.Key+"/images", "Other")
	require.Equal(t, http.StatusForbidden, s.as(http.MethodDelete, base+"/images/"+otherImage.ID.String(), nil).Code)
	require.Equal(t, http.StatusNoContent, s.as(http.MethodDelete, base+"/images/"+ownImage.ID.String(), nil).Code)
	for _, suffix := range []string{"/activate", "/close"} {
		rec := s.as(http.MethodPost, base+"/sprints/"+ownSprint.ID.String()+suffix, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	require.Equal(t, http.StatusOK, s.as(http.MethodGet, base+"/sprints/"+ownSprint.ID.String()+"/snapshot", nil).Code)
	setRole(t, s.f, "viewer")
	require.Equal(t, http.StatusForbidden, s.as(http.MethodPatch, base+"/sprints/"+ownSprint.ID.String(), map[string]string{"name": "Blocked"}).Code)
}

func TestScopedReportAndMentionSelectors(t *testing.T) {
	s := newScopedSetup(t)
	base := "/api/v1/w/lab"
	for _, path := range []string{"/reports/activity", "/reports/milestones", "/reports/closed", "/reports/stale", "/mentions"} {
		rec := s.as(http.MethodGet, base+path, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		for _, query := range []string{"?project=other", "?project_id=" + s.other.String(), "?project=own&project=other", "?project_id=" + s.ownProject.String() + "&project=other"} {
			rec := s.as(http.MethodGet, base+path+query, nil)
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		}
	}
	for _, target := range []struct {
		path string
		body any
	}{
		{"/issues", map[string]any{"title": "No", "project_id": s.ownProject, "project": "other"}},
		{"/sprints", map[string]any{"name": "No", "starts_on": "2026-11-01", "ends_on": "2026-11-30", "project_id": s.ownProject, "project": "other"}},
	} {
		rec := s.as(http.MethodPost, base+target.path, target.body)
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	c, err := s.f.Store.CreateComment(t.Context(), store.CreateCommentInput{WorkspaceID: s.f.WorkspaceID, ActorID: s.f.User.ID, TargetType: "issue", TargetID: s.otherIssue.ID, Body: "Other mention", Source: "human"})
	require.NoError(t, err)
	rec := s.as(http.MethodPost, base+"/mentions/read", map[string]any{"comment_ids": []uuid.UUID{c.ID}})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	rec = s.as(http.MethodPost, base+"/mentions/read?project=other", nil)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}
