package api

import (
	"errors"
	"net/http"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerMembershipRoutes(mux *http.ServeMux) {
	admin := RequireRole("admin")
	mux.Handle("GET /api/v1/w/{slug}/members",
		s.RequireWorkspace(http.HandlerFunc(s.handleListMembers)))
	mux.Handle("GET /api/v1/w/{slug}/memberships",
		s.RequireWorkspace(admin(http.HandlerFunc(s.handleListMemberships))))
	mux.Handle("PATCH /api/v1/w/{slug}/memberships/{id}",
		s.RequireWorkspace(admin(http.HandlerFunc(s.handleUpdateMembershipRole))))
}

func (s *Server) handleListMembers(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	members, err := s.store.ListWorkspaceMembers(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list members")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *Server) handleListMemberships(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	memberships, err := s.store.ListWorkspaceMemberships(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list memberships")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"memberships": memberships})
}

func (s *Server) handleUpdateMembershipRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if !validMembershipRole(body.Role) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "role must be admin, member, or viewer")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	membership, err := s.store.UpdateWorkspaceMembershipRole(
		r.Context(), ws.WorkspaceID, id, user.ID, body.Role)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			WriteError(w, http.StatusNotFound, "not_found", "no such membership")
		case errors.Is(err, store.ErrLastAdmin):
			WriteError(w, http.StatusConflict, "last_admin", err.Error())
		default:
			WriteError(w, http.StatusInternalServerError, "internal", "could not update the membership")
		}
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, membership)
}

func validMembershipRole(role string) bool {
	return role == "admin" || role == "member" || role == "viewer"
}
