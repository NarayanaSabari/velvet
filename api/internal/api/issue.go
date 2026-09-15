package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerIssueRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/issues",
		s.RequireWorkspace(http.HandlerFunc(s.handleListIssues)))
	mux.Handle("POST /api/v1/w/{slug}/issues",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateIssue))))
	mux.Handle("GET /api/v1/w/{slug}/issues/{key}",
		s.RequireWorkspace(http.HandlerFunc(s.handleGetIssue)))
	mux.Handle("PATCH /api/v1/w/{slug}/issues/{key}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleUpdateIssue))))
}

func (s *Server) handleListIssues(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	query := r.URL.Query()

	filter := store.IssueFilter{
		Statuses: query["status"],
		Cursor:   query.Get("cursor"),
	}
	for _, f := range []struct {
		key string
		dst **uuid.UUID
	}{
		{"milestone_id", &filter.MilestoneID},
		{"sprint_id", &filter.SprintID},
		{"assignee_id", &filter.AssigneeID},
	} {
		id, ok := queryUUID(w, query.Get(f.key), f.key)
		if !ok {
			return
		}
		*f.dst = id
	}
	for _, status := range filter.Statuses {
		if !store.ValidIssueStatus(status) {
			WriteError(w, http.StatusBadRequest, "invalid_request", "unknown status "+status)
			return
		}
	}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 {
			WriteError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		filter.Limit = limit
	}

	issues, next, err := s.store.ListIssues(r.Context(), ws.WorkspaceID, filter)
	if err != nil {
		if errors.Is(err, store.ErrInvalidCursor) {
			WriteError(w, http.StatusBadRequest, "invalid_request", "cursor is not valid")
			return
		}
		WriteError(w, http.StatusInternalServerError, "internal", "could not list issues")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"issues": issues, "next_cursor": next})
}

func (s *Server) handleCreateIssue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title       string  `json:"title"`
		Description string  `json:"description"`
		Status      string  `json:"status"`
		Priority    int     `json:"priority"`
		AssigneeID  *string `json:"assignee_id"`
		MilestoneID *string `json:"milestone_id"`
		ParentID    *string `json:"parent_id"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Title == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "title is required")
		return
	}
	if body.Status != "" && !store.ValidIssueStatus(body.Status) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"status must be one of backlog, todo, in_progress, in_review, done, cancelled")
		return
	}
	if body.Priority < 0 || body.Priority > 4 {
		WriteError(w, http.StatusBadRequest, "invalid_request", "priority must be between 0 and 4")
		return
	}

	in := store.CreateIssueInput{
		Title: body.Title, Description: body.Description,
		Status: body.Status, Priority: body.Priority,
	}
	for _, f := range []struct {
		raw *string
		dst **uuid.UUID
		key string
	}{
		{body.AssigneeID, &in.AssigneeID, "assignee_id"},
		{body.MilestoneID, &in.MilestoneID, "milestone_id"},
		{body.ParentID, &in.ParentID, "parent_id"},
	} {
		id, ok := parseOptionalUUID(w, f.raw, f.key)
		if !ok {
			return
		}
		*f.dst = id
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	in.WorkspaceID = ws.WorkspaceID
	in.ActorID = user.ID

	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	issue, err := s.store.CreateIssue(r.Context(), in)
	if err != nil {
		writeIssueError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusCreated, issue)
}

func (s *Server) handleGetIssue(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, pathIssueKey(r))
	if err != nil {
		writeIssueError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, issue)
}

func (s *Server) handleUpdateIssue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		Priority    *int    `json:"priority"`
		AssigneeID  *string `json:"assignee_id"`
		MilestoneID *string `json:"milestone_id"`
		ParentID    *string `json:"parent_id"`
		AfterID     *string `json:"after_id"`
		BeforeID    *string `json:"before_id"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Status != nil && !store.ValidIssueStatus(*body.Status) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"status must be one of backlog, todo, in_progress, in_review, done, cancelled")
		return
	}
	if body.Priority != nil && (*body.Priority < 0 || *body.Priority > 4) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "priority must be between 0 and 4")
		return
	}

	patch := store.IssuePatch{
		Title: body.Title, Description: body.Description,
		Status: body.Status, Priority: body.Priority,
	}
	// An explicit null clears the reference, while omitting the field leaves
	// it alone, which is why these patch fields are double pointers.
	for _, f := range []struct {
		raw *string
		dst ***uuid.UUID
		key string
	}{
		{body.AssigneeID, &patch.AssigneeID, "assignee_id"},
		{body.MilestoneID, &patch.MilestoneID, "milestone_id"},
		{body.ParentID, &patch.ParentID, "parent_id"},
	} {
		if f.raw == nil {
			continue
		}
		id, ok := parseOptionalUUID(w, f.raw, f.key)
		if !ok {
			return
		}
		*f.dst = &id
	}
	for _, f := range []struct {
		raw *string
		dst **uuid.UUID
		key string
	}{{body.AfterID, &patch.AfterID, "after_id"}, {body.BeforeID, &patch.BeforeID, "before_id"}} {
		id, ok := parseOptionalUUID(w, f.raw, f.key)
		if !ok {
			return
		}
		*f.dst = id
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, pathIssueKey(r))
	if err != nil {
		writeIssueError(w, err)
		return
	}
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	updated, err := s.store.UpdateIssue(r.Context(), ws.WorkspaceID, issue.ID, user.ID, patch)
	if err != nil {
		writeIssueError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, updated)
}

// writeIssueError answers 400 for illegal nesting, because a rejected parent
// is a client mistake and never an internal failure.
func writeIssueError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrInvalidNesting) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"sub-issues may be nested only one level")
		return
	}
	writeStoreError(w, err, "issue")
}

// queryUUID parses an optional query parameter, answering 400 rather than 500
// on junk.
func queryUUID(w http.ResponseWriter, raw, name string) (*uuid.UUID, bool) {
	if raw == "" {
		return nil, true
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", name+" must be a UUID")
		return nil, false
	}
	return &id, true
}
