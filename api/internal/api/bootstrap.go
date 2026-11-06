package api

import (
	"net/http"
)

// registerBootstrapRoutes adds one call that returns what a client needs
// before it can render a workspace: projects, members and labels. Clients
// previously paid three round trips for three sub-millisecond queries.
func (s *Server) registerBootstrapRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/w/{slug}/bootstrap",
		s.RequireWorkspace(http.HandlerFunc(s.handleBootstrap)))
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	projects, err := s.store.ListProjects(r.Context(), ws.WorkspaceID, false)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list projects")
		return
	}
	members, err := s.store.ListWorkspaceMembers(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list members")
		return
	}
	labels, err := s.store.ListLabels(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list labels")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"projects": projects,
		"members":  members,
		"labels":   labels,
	})
}
