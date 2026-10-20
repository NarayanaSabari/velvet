package api

import (
	"errors"
	"net/http"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// Jev suggestions: where unlinked pull requests and project notes probably
// belong. Reading them is open to every member; acting on one is a write, and
// the organisation setting belongs to admins.
func (s *Server) registerSuggestionRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	admin := RequireRole("admin")

	mux.Handle("GET /api/v1/w/{slug}/suggestions/notes",
		s.RequireWorkspace(http.HandlerFunc(s.handleSuggestedNotes)))
	mux.Handle("POST /api/v1/w/{slug}/suggestions/{id}/accept",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleAcceptSuggestion))))
	mux.Handle("POST /api/v1/w/{slug}/suggestions/{id}/dismiss",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleDismissSuggestion))))
	mux.Handle("GET /api/v1/w/{slug}/suggestions/settings",
		s.RequireWorkspace(http.HandlerFunc(s.handleSuggestionSettings)))
	mux.Handle("PATCH /api/v1/w/{slug}/suggestions/settings",
		s.RequireWorkspace(admin(http.HandlerFunc(s.handleUpdateSuggestionSettings))))
}

func (s *Server) handleSuggestedNotes(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	notes, err := s.store.SuggestedNotes(r.Context(), ws.WorkspaceID, 0)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list suggested notes")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

func (s *Server) handleAcceptSuggestion(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	key, err := s.store.AcceptSuggestion(r.Context(), ws.WorkspaceID, id, user.ID)
	if err != nil {
		writeSuggestionError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, map[string]any{"issue_key": key})
}

func (s *Server) handleDismissSuggestion(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	if err := s.store.DismissSuggestion(r.Context(), ws.WorkspaceID, id, user.ID); err != nil {
		writeSuggestionError(w, err)
		return
	}
	WriteJSON(w, http.StatusNoContent, nil)
}

// suggestionSettings says both what the organisation chose and whether the
// server can act on it, so the page never implies suggestions are running
// when no TypeSafe key is configured.
type suggestionSettings struct {
	Enabled   bool `json:"enabled"`
	Available bool `json:"available"`
}

func (s *Server) handleSuggestionSettings(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	enabled, err := s.store.JevSuggestionsEnabled(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the suggestion setting")
		return
	}
	WriteJSON(w, http.StatusOK, suggestionSettings{Enabled: enabled, Available: s.cfg.TypeSafeConfigured})
}

func (s *Server) handleUpdateSuggestionSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "enabled is required")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	if err := s.store.SetJevSuggestions(r.Context(), ws.WorkspaceID, user.ID, *body.Enabled); err != nil {
		writeOrganisationError(w, err, "could not change the suggestion setting")
		return
	}
	WriteJSON(w, http.StatusOK, suggestionSettings{Enabled: *body.Enabled, Available: s.cfg.TypeSafeConfigured})
}

func writeSuggestionError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrSuggestionClosed) {
		WriteError(w, http.StatusConflict, "suggestion_closed",
			"this suggestion was already handled or its issue is closed")
		return
	}
	writeStoreError(w, err, "suggestion")
}
