package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerCommentRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/issues/{key}/comments",
		s.RequireWorkspace(http.HandlerFunc(s.handleListIssueComments)))
	mux.Handle("POST /api/v1/w/{slug}/issues/{key}/comments",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateIssueComment))))
	mux.Handle("GET /api/v1/w/{slug}/milestones/{id}/comments",
		s.RequireWorkspace(http.HandlerFunc(s.handleListMilestoneComments)))
	mux.Handle("POST /api/v1/w/{slug}/milestones/{id}/comments",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateMilestoneComment))))
	mux.Handle("GET /api/v1/w/{slug}/projects/{key}/comments",
		s.RequireWorkspace(http.HandlerFunc(s.handleListProjectComments)))
	mux.Handle("POST /api/v1/w/{slug}/projects/{key}/comments",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateProjectComment))))
	mux.Handle("PATCH /api/v1/w/{slug}/comments/{id}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleUpdateComment))))
	mux.Handle("DELETE /api/v1/w/{slug}/comments/{id}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleDeleteComment))))
	mux.Handle("POST /api/v1/w/{slug}/comments/{id}/promote",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handlePromoteComment))))
	mux.Handle("GET /api/v1/w/{slug}/mentions",
		s.RequireWorkspace(http.HandlerFunc(s.handleListMentions)))
	mux.Handle("POST /api/v1/w/{slug}/mentions/read",
		s.RequireWorkspace(http.HandlerFunc(s.handleMarkMentionsRead)))
}

// issueTargetID resolves {key} to an issue id, so a key belonging to another
// workspace answers 404 rather than commenting across the boundary.
func (s *Server) issueTargetID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	ws, _ := CurrentWorkspace(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, pathIssueKey(r))
	if err != nil {
		writeIssueError(w, err)
		return uuid.Nil, false
	}
	return issue.ID, true
}

func (s *Server) handleListIssueComments(w http.ResponseWriter, r *http.Request) {
	id, ok := s.issueTargetID(w, r)
	if !ok {
		return
	}
	s.listComments(w, r, "issue", id)
}

func (s *Server) handleCreateIssueComment(w http.ResponseWriter, r *http.Request) {
	id, ok := s.issueTargetID(w, r)
	if !ok {
		return
	}
	s.createComment(w, r, "issue", id)
}

func (s *Server) handleListMilestoneComments(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	s.listComments(w, r, "milestone", id)
}

func (s *Server) handleCreateMilestoneComment(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	s.createComment(w, r, "milestone", id)
}

// projectTargetID resolves {key} to a project id, so a key belonging to
// another workspace answers 404 rather than logging across the boundary.
func (s *Server) projectTargetID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	ws, _ := CurrentWorkspace(r.Context())
	id, err := s.store.ProjectIDByKey(r.Context(), ws.WorkspaceID, pathProjectKey(r))
	if err != nil {
		writeProjectError(w, err, "could not read the project")
		return uuid.Nil, false
	}
	return id, true
}

func (s *Server) handleListProjectComments(w http.ResponseWriter, r *http.Request) {
	id, ok := s.projectTargetID(w, r)
	if !ok {
		return
	}
	s.listComments(w, r, "project", id)
}

// handleCreateProjectComment is where an agent logs work it cannot attach to a
// ticket. Without it the only honest option was to write nothing, and an
// unwritten log is exactly the problem this product exists to solve.
func (s *Server) handleCreateProjectComment(w http.ResponseWriter, r *http.Request) {
	id, ok := s.projectTargetID(w, r)
	if !ok {
		return
	}
	s.createComment(w, r, "project", id)
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request, targetType string, targetID uuid.UUID) {
	ws, _ := CurrentWorkspace(r.Context())
	comments, err := s.store.ListComments(r.Context(), ws.WorkspaceID, targetType, targetID)
	if err != nil {
		writeCommentError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"comments": comments})
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request, targetType string, targetID uuid.UUID) {
	var body struct {
		Body     string  `json:"body"`
		ParentID *string `json:"parent_id"`
		Kind     *string `json:"kind"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "body is required")
		return
	}
	if body.Kind != nil && !store.ValidCommentKind(*body.Kind) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"kind must be one of progress, decision, blocker, note")
		return
	}
	parentID, ok := parseOptionalUUID(w, body.ParentID, "parent_id")
	if !ok {
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	comment, err := s.store.CreateComment(r.Context(), store.CreateCommentInput{
		WorkspaceID: ws.WorkspaceID, ActorID: user.ID,
		TargetType: targetType, TargetID: targetID,
		ParentID: parentID, Body: body.Body, Kind: body.Kind,
		// Source and token come from how the request authenticated, never
		// from the body, so an entry cannot misreport who wrote it.
		Source:     commentSource(r.Context()),
		APITokenID: currentAPIToken(r.Context()),
	})
	if err != nil {
		writeCommentError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusCreated, comment)
}

func (s *Server) handleUpdateComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Body string `json:"body"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "body is required")
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	comment, err := s.store.UpdateComment(r.Context(), ws.WorkspaceID, id, user.ID, body.Body)
	if err != nil {
		writeCommentError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, comment)
}

func (s *Server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	err := s.store.DeleteComment(r.Context(), ws.WorkspaceID, id, user.ID, ws.Role == "admin")
	if err != nil {
		writeCommentError(w, err)
		return
	}
	WriteJSON(w, http.StatusNoContent, nil)
}

// handlePromoteComment turns a project work-log entry into a ticket, so a note
// jotted down before anyone filed the work does not stay buried in the log.
func (s *Server) handlePromoteComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	body.Title = strings.TrimSpace(body.Title)
	if body.Title == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "title is required")
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	issue, err := s.store.PromoteCommentToIssue(r.Context(), ws.WorkspaceID, id, user.ID, body.Title)
	if err != nil {
		if errors.Is(err, store.ErrNotPromotable) {
			WriteError(w, http.StatusBadRequest, "invalid_request",
				"only a project work-log entry can be promoted to a ticket")
			return
		}
		writeCommentError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusCreated, issue)
}

func (s *Server) handleListMentions(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	unreadOnly := r.URL.Query().Get("unread") == "true"

	mentions, err := s.store.ListMentions(r.Context(), ws.WorkspaceID, user.ID, unreadOnly)
	if err != nil {
		writeCommentError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"mentions": mentions})
}

func (s *Server) handleMarkMentionsRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CommentIDs []string `json:"comment_ids"`
	}
	// An empty body marks everything read, which is what a "mark all" button
	// sends.
	if r.ContentLength > 0 && !DecodeJSON(w, r, &body) {
		return
	}
	ids := make([]uuid.UUID, 0, len(body.CommentIDs))
	for _, raw := range body.CommentIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid_request", "comment_ids must be UUIDs")
			return
		}
		ids = append(ids, id)
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	if err := s.store.MarkMentionsRead(r.Context(), ws.WorkspaceID, user.ID, ids); err != nil {
		writeCommentError(w, err)
		return
	}
	WriteJSON(w, http.StatusNoContent, nil)
}

// writeCommentError separates the two client mistakes worth naming: a reply
// nested too deep, and an edit of someone else's comment.
func writeCommentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrInvalidNesting):
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"comment replies may be nested only one level")
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, http.StatusForbidden, "forbidden",
			"only the author may change this comment")
	default:
		writeStoreError(w, err, "comment")
	}
}
