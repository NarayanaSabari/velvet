package api

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

var organisationSlug = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`)
var organisationPrefix = regexp.MustCompile(`^[A-Z]{2,6}$`)
var reservedOrganisationSlugs = map[string]bool{
	"admin": true, "api": true, "auth": true, "check-email": true, "expired": true,
	"invite": true, "invites": true, "me": true, "new": true, "orgs": true,
	"settings": true, "signin": true, "signout": true, "w": true, "webhooks": true,
}

func (s *Server) registerOrganisationRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/orgs", s.RequireAuth(http.HandlerFunc(s.handleCreateOrganisation)))
	mux.Handle("DELETE /api/v1/w/{slug}", s.RequireWorkspace(RequireRole("admin")(http.HandlerFunc(s.handleDeleteOrganisation))))
	mux.Handle("POST /api/v1/w/{slug}/leave", s.RequireWorkspace(http.HandlerFunc(s.handleLeaveOrganisation)))
}

func (s *Server) handleCreateOrganisation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		IssuePrefix string `json:"issue_prefix"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || !organisationSlug.MatchString(body.Slug) || reservedOrganisationSlugs[body.Slug] || !organisationPrefix.MatchString(body.IssuePrefix) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "a name, valid organisation slug, and 2 to 6 uppercase letter issue prefix are required")
		return
	}
	user, _ := CurrentUser(r.Context())
	m, err := s.store.CreateWorkspace(r.Context(), user.ID, body.Name, body.Slug, body.IssuePrefix)
	if err != nil {
		writeOrganisationError(w, err, "could not create the organisation")
		return
	}
	WriteJSON(w, http.StatusCreated, m)
}

func (s *Server) handleDeleteOrganisation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm string `json:"confirm"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	if body.Confirm != ws.Slug {
		WriteError(w, http.StatusBadRequest, "invalid_request", "confirmation must match the organisation slug")
		return
	}
	user, _ := CurrentUser(r.Context())
	if err := s.store.DeleteWorkspace(r.Context(), ws.WorkspaceID, user.ID); err != nil {
		writeOrganisationError(w, err, "could not delete the organisation")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLeaveOrganisation(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	if err := s.store.LeaveWorkspace(r.Context(), ws.WorkspaceID, user.ID); err != nil {
		writeOrganisationError(w, err, "could not leave the organisation")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	w.WriteHeader(http.StatusNoContent)
}

func writeOrganisationError(w http.ResponseWriter, err error, message string) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, http.StatusNotFound, "not_found", "no such organisation or resource")
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, http.StatusForbidden, "forbidden", "insufficient permission")
	case errors.Is(err, store.ErrLastAdmin):
		WriteError(w, http.StatusConflict, "last_admin", "the organisation must retain at least one admin")
	case errors.Is(err, store.ErrDuplicate):
		WriteError(w, http.StatusConflict, "conflict", "the organisation slug is already in use")
	default:
		WriteError(w, http.StatusInternalServerError, "internal", message)
	}
}
