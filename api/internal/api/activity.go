package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerActivityRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/w/{slug}/activity",
		s.RequireWorkspace(http.HandlerFunc(s.handleListActivity)))
	mux.Handle("GET /api/v1/w/{slug}/dashboard",
		s.RequireWorkspace(http.HandlerFunc(s.handleDashboard)))
	mux.Handle("GET /api/v1/w/{slug}/stream",
		s.RequireWorkspace(http.HandlerFunc(s.handleStream)))
}

func (s *Server) handleListActivity(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	query := r.URL.Query()

	filter := store.ActivityFilter{
		Verbs:      query["verb"],
		TargetType: query.Get("target_type"),
		Cursor:     query.Get("cursor"),
	}
	actorID, ok := queryUUID(w, query.Get("actor_id"), "actor_id")
	if !ok {
		return
	}
	filter.ActorID = actorID
	targetID, ok := queryUUID(w, query.Get("target_id"), "target_id")
	if !ok {
		return
	}
	filter.TargetID = targetID
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 {
			WriteError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		filter.Limit = limit
	}

	activity, next, err := s.store.ListActivity(r.Context(), ws.WorkspaceID, filter)
	if err != nil {
		if errors.Is(err, store.ErrInvalidCursor) {
			WriteError(w, http.StatusBadRequest, "invalid_request", "cursor is not valid")
			return
		}
		WriteError(w, http.StatusInternalServerError, "internal", "could not list activity")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"activity": activity, "next_cursor": next})
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())

	dash, err := s.store.Dashboard(r.Context(), ws.WorkspaceID, user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the dashboard")
		return
	}
	WriteJSON(w, http.StatusOK, dash)
}
