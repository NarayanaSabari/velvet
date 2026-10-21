package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// `velvet init` signs in like a TV app: the CLI starts a session and shows a
// short code and a link; the person approves in the browser they are already
// signed in to, choosing one organisation and one project; the CLI's next
// poll collects a key bound to exactly that choice.
func (s *Server) registerCLIAuthRoutes(mux *http.ServeMux) {
	// The CLI's two calls carry no credential: the device secret in the body
	// is what proves it started the session.
	mux.HandleFunc("POST /api/v1/cli/sessions", s.handleCreateCLISession)
	mux.HandleFunc("POST /api/v1/cli/sessions/token", s.handleCollectCLISession)
	// The browser's calls need a signed-in session, never an API key, so an
	// agent holding a key cannot approve its own escalation.
	mux.Handle("GET /api/v1/cli/sessions/{code}", s.RequireAuth(http.HandlerFunc(s.handleGetCLISession)))
	mux.Handle("POST /api/v1/cli/sessions/{code}/approve", s.RequireAuth(http.HandlerFunc(s.handleApproveCLISession)))
	mux.Handle("POST /api/v1/cli/sessions/{code}/deny", s.RequireAuth(http.HandlerFunc(s.handleDenyCLISession)))
}

func (s *Server) handleCreateCLISession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientName string `json:"client_name"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	device, session, err := s.store.CreateCLISession(r.Context(), body.ClientName)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start sign-in")
		return
	}
	code := store.FormatUserCode(session.UserCode)
	verify := strings.TrimRight(s.cfg.BaseURL, "/") + "/cli/approve"
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusCreated, map[string]any{
		"device_code":               device,
		"user_code":                 code,
		"verification_uri":          verify,
		"verification_uri_complete": verify + "?code=" + url.QueryEscape(code),
		"expires_at":                session.ExpiresAt,
		"interval":                  2,
	})
}

func (s *Server) handleCollectCLISession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceCode string `json:"device_code"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if strings.TrimSpace(body.DeviceCode) == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "device_code is required")
		return
	}
	grant, err := s.store.CollectCLISession(r.Context(), body.DeviceCode)
	switch {
	case err == nil:
		WriteJSON(w, http.StatusOK, grant)
	case errors.Is(err, store.ErrCLISessionPending):
		WriteError(w, http.StatusAccepted, "authorization_pending", "waiting for approval in the browser")
	case errors.Is(err, store.ErrCLISessionDenied):
		WriteError(w, http.StatusForbidden, "access_denied", "the sign-in was refused")
	case errors.Is(err, store.ErrCLISessionExpired):
		WriteError(w, http.StatusGone, "expired_token", "the sign-in expired; run velvet init again")
	case errors.Is(err, store.ErrAPITokenLimit):
		WriteError(w, http.StatusConflict, "token_limit", "you already have 20 keys; revoke one under Profile > API tokens")
	default:
		WriteError(w, http.StatusInternalServerError, "internal", "could not complete sign-in")
	}
}

func (s *Server) handleGetCLISession(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	session, err := s.store.CLISessionByCode(r.Context(), r.PathValue("code"))
	if err != nil {
		WriteError(w, http.StatusNotFound, "not_found", "that code has expired or was already used")
		return
	}
	session.UserCode = store.FormatUserCode(session.UserCode)
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, session)
}

func (s *Server) handleApproveCLISession(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	var body struct {
		WorkspaceSlug string `json:"workspace_slug"`
		ProjectKey    string `json:"project_key"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	user, _ := CurrentUser(r.Context())
	membership, err := s.store.MembershipForSlug(r.Context(), user.ID, body.WorkspaceSlug)
	if err != nil {
		WriteError(w, http.StatusNotFound, "not_found", "no such organisation")
		return
	}
	projectID, err := s.store.ProjectIDByKey(r.Context(), membership.WorkspaceID, store.NormalizeProjectKey(body.ProjectKey))
	if err != nil {
		writeProjectError(w, err, "could not resolve the project")
		return
	}
	err = s.store.ApproveCLISession(r.Context(), r.PathValue("code"), user.ID, membership.WorkspaceID, projectID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, http.StatusForbidden, "forbidden", "viewers cannot connect an agent that writes to this organisation")
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, http.StatusNotFound, "not_found", "that code has expired or was already used")
	default:
		WriteError(w, http.StatusInternalServerError, "internal", "could not approve the sign-in")
	}
}

func (s *Server) handleDenyCLISession(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	if err := s.store.DenyCLISession(r.Context(), r.PathValue("code")); err != nil {
		WriteError(w, http.StatusNotFound, "not_found", "that code has expired or was already used")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
