package api

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *Server) registerLabelRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/labels",
		s.RequireWorkspace(http.HandlerFunc(s.handleListLabels)))
	mux.Handle("POST /api/v1/w/{slug}/labels",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateLabel))))
	mux.Handle("DELETE /api/v1/w/{slug}/labels/{id}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleDeleteLabel))))
	mux.Handle("PUT /api/v1/w/{slug}/issues/{key}/labels",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleSetIssueLabels))))
}

func (s *Server) handleListLabels(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	labels, err := s.store.ListLabels(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list labels")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"labels": labels})
}

func (s *Server) handleCreateLabel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Name == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	if body.Color == "" {
		body.Color = "#111111"
	}
	if !colorRe.MatchString(body.Color) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "color must be #rrggbb")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	label, err := s.store.CreateLabel(r.Context(), ws.WorkspaceID, body.Name, body.Color)
	if err != nil {
		writeLabelError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, label)
}

func (s *Server) handleDeleteLabel(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteLabel(r.Context(), ws.WorkspaceID, id); err != nil {
		writeLabelError(w, err)
		return
	}
	WriteJSON(w, http.StatusNoContent, nil)
}

func (s *Server) handleSetIssueLabels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LabelIDs []string `json:"label_ids"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	labelIDs := make([]uuid.UUID, 0, len(body.LabelIDs))
	for _, raw := range body.LabelIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid_request", "label_ids must be UUIDs")
			return
		}
		labelIDs = append(labelIDs, id)
	}

	ws, _ := CurrentWorkspace(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, pathIssueKey(r))
	if err != nil {
		writeIssueError(w, err)
		return
	}
	labels, err := s.store.SetIssueLabels(r.Context(), ws.WorkspaceID, issue.ID, labelIDs)
	if err != nil {
		writeLabelError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"labels": labels})
}

// writeLabelError separates the two client mistakes worth naming: a name
// already taken, and a label owned by another workspace.
func writeLabelError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrDuplicate):
		WriteError(w, http.StatusConflict, "conflict", "a label with that name already exists")
	case errors.Is(err, store.ErrForeignReference):
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"every label must belong to this workspace")
	default:
		writeStoreError(w, err, "label")
	}
}
