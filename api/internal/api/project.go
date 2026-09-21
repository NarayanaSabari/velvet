package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerProjectRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/projects",
		s.RequireWorkspace(http.HandlerFunc(s.handleListProjects)))
	mux.Handle("POST /api/v1/w/{slug}/projects",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateProject))))
	mux.Handle("GET /api/v1/w/{slug}/projects/{key}",
		s.RequireWorkspace(http.HandlerFunc(s.handleGetProject)))
	mux.Handle("PATCH /api/v1/w/{slug}/projects/{key}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleUpdateProject))))
	mux.Handle("PUT /api/v1/w/{slug}/repos/{id}/project",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleSetRepoProject))))
}

// pathProjectKey normalizes at the HTTP boundary, so every route below can use
// the indexed exact lookup, matching pathIssueKey.
func pathProjectKey(r *http.Request) string {
	return store.NormalizeProjectKey(r.PathValue("key"))
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	// Archived projects are hidden by default: the list answers "what am I
	// working on", and finished work would otherwise crowd that out.
	includeArchived := r.URL.Query().Get("include_archived") == "true"
	projects, err := s.store.ListProjects(r.Context(), ws.WorkspaceID, includeArchived)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list projects")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key         string `json:"key"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	key := store.NormalizeProjectKey(body.Key)
	if body.Name == "" || utf8.RuneCountInString(body.Name) > 80 {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"project name must be between 1 and 80 characters")
		return
	}
	if !store.ValidProjectKey(key) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"project key must be 1 to 40 lowercase letters, digits, or hyphens, and start and end with a letter or digit")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	project, err := s.store.CreateProject(r.Context(), store.CreateProjectInput{
		WorkspaceID: ws.WorkspaceID, ActorID: user.ID,
		Key: key, Name: body.Name, Description: body.Description,
	})
	if err != nil {
		writeProjectError(w, err, "could not create the project")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusCreated, project)
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	project, err := s.store.GetProjectByKey(r.Context(), ws.WorkspaceID, pathProjectKey(r))
	if err != nil {
		writeProjectError(w, err, "could not read the project")
		return
	}
	WriteJSON(w, http.StatusOK, project)
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Name != nil {
		trimmed := strings.TrimSpace(*body.Name)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > 80 {
			WriteError(w, http.StatusBadRequest, "invalid_request",
				"project name must be between 1 and 80 characters")
			return
		}
		body.Name = &trimmed
	}
	if body.Status != nil && !store.ValidProjectStatus(*body.Status) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"status must be active or archived")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	project, err := s.store.GetProjectByKey(r.Context(), ws.WorkspaceID, pathProjectKey(r))
	if err != nil {
		writeProjectError(w, err, "could not read the project")
		return
	}

	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	updated, err := s.store.UpdateProject(r.Context(), ws.WorkspaceID, project.ID, user.ID,
		store.ProjectPatch{Name: body.Name, Description: body.Description, Status: body.Status})
	if err != nil {
		writeProjectError(w, err, "could not update the project")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, updated)
}

// handleSetRepoProject maps a repository to a project. This is what lets a
// commit on a branch that names no issue still be attributed to the work it
// belongs to, rather than being recorded with no home.
func (s *Server) handleSetRepoProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ProjectID *string `json:"project_id"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	repoID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	projectID, ok := parseOptionalUUID(w, body.ProjectID, "project_id")
	if !ok {
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	if err := s.store.SetRepoProject(r.Context(), ws.WorkspaceID, repoID, user.ID, projectID); err != nil {
		writeProjectError(w, err, "could not map the repository to a project")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	w.WriteHeader(http.StatusNoContent)
}

func writeProjectError(w http.ResponseWriter, err error, message string) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, http.StatusNotFound, "not_found", "no such project")
	case errors.Is(err, store.ErrDuplicate):
		WriteError(w, http.StatusConflict, "conflict", "a project with that key already exists")
	default:
		WriteError(w, http.StatusInternalServerError, "internal", message)
	}
}
