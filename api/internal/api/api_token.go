package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerAPITokenRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/me/tokens", s.RequireAuth(http.HandlerFunc(s.handleListAPITokens)))
	mux.Handle("POST /api/v1/me/tokens", s.RequireAuth(http.HandlerFunc(s.handleCreateAPIToken)))
	mux.Handle("DELETE /api/v1/me/tokens/{id}", s.RequireAuth(http.HandlerFunc(s.handleDeleteAPIToken)))
}

func requireCookieAuthentication(w http.ResponseWriter, r *http.Request) bool {
	if isBearerAuth(r.Context()) {
		WriteError(w, http.StatusForbidden, "forbidden", "a browser session is required to manage API tokens")
		return false
	}
	return true
}

func (s *Server) handleListAPITokens(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	user, _ := CurrentUser(r.Context())
	tokens, err := s.store.ListAPITokens(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list API tokens")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"tokens": tokens})
}

func (s *Server) handleCreateAPIToken(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "a token name is required")
		return
	}

	user, _ := CurrentUser(r.Context())
	raw, err := s.store.CreateAPIToken(r.Context(), user.ID, body.Name)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrInvalidAPITokenName):
			WriteError(w, http.StatusBadRequest, "invalid_request", "a token name is required")
		case errors.Is(err, store.ErrDuplicate):
			WriteError(w, http.StatusConflict, "conflict", "a token with that name already exists")
		case errors.Is(err, store.ErrAPITokenLimit):
			WriteError(w, http.StatusConflict, "token_limit", "a user may have at most 20 API tokens")
		default:
			WriteError(w, http.StatusInternalServerError, "internal", "could not create API token")
		}
		return
	}

	// CreateAPIToken intentionally returns only the one-time secret. Resolve its
	// safe metadata separately so the response never needs to select a hash.
	tokens, err := s.store.ListAPITokens(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the created API token")
		return
	}
	var created store.APIToken
	for _, token := range tokens {
		if token.Name == body.Name {
			created = token
			break
		}
	}
	if created.ID == uuid.Nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the created API token")
		return
	}

	WriteJSON(w, http.StatusCreated, struct {
		ID    uuid.UUID `json:"id"`
		Name  string    `json:"name"`
		Token string    `json:"token"`
	}{ID: created.ID, Name: created.Name, Token: raw})
}

func (s *Server) handleDeleteAPIToken(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	user, _ := CurrentUser(r.Context())
	if err := s.store.DeleteAPIToken(r.Context(), user.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, http.StatusNotFound, "not_found", "no such API token")
			return
		}
		WriteError(w, http.StatusInternalServerError, "internal", "could not delete API token")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
