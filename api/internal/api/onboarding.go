package api

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

// Onboarding gets a new person from sign-in to an agent that writes to their
// work log: an organisation named after them, one API token, and a hosted MCP
// URL. These routes support that flow without changing the general
// organisation and token APIs it builds on.
func (s *Server) registerOnboardingRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/me/onboarding", s.RequireAuth(http.HandlerFunc(s.handleOnboarding)))
	mux.Handle("POST /api/v1/me/onboarding/organisation", s.RequireAuth(http.HandlerFunc(s.handleOnboardingOrganisation)))
}

// handleOnboarding reports progress and suggests defaults for the first
// organisation, so the form can be filled in before the person types.
func (s *Server) handleOnboarding(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	user, _ := CurrentUser(r.Context())
	state, err := s.store.Onboarding(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read onboarding progress")
		return
	}
	suggestion, err := s.store.SuggestOrganisation(r.Context(), user)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not suggest an organisation")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, map[string]any{
		"state":      state,
		"suggestion": suggestion,
		// The MCP URL is built from the public origin rather than the request,
		// so it matches what an agent outside this network will reach.
		"base_url": strings.TrimRight(s.cfg.BaseURL, "/"),
	})
}

// handleOnboardingOrganisation creates the person's organisation from the
// suggested defaults unless they changed them. Any field may be omitted; a
// taken slug moves to the next free number rather than failing the step.
func (s *Server) handleOnboardingOrganisation(w http.ResponseWriter, r *http.Request) {
	if !requireCookieAuthentication(w, r) {
		return
	}
	var body struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		IssuePrefix string `json:"issue_prefix"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	user, _ := CurrentUser(r.Context())
	suggestion, err := s.store.SuggestOrganisation(r.Context(), user)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not suggest an organisation")
		return
	}

	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" {
		name = suggestion.Name
	}
	slug := strings.TrimSpace(body.Slug)
	if slug == "" {
		slug = suggestion.Slug
	}
	prefix := strings.ToUpper(strings.TrimSpace(body.IssuePrefix))
	if prefix == "" {
		prefix = suggestion.IssuePrefix
	}
	if utf8.RuneCountInString(name) > 80 {
		WriteError(w, http.StatusBadRequest, "invalid_request", "organisation name must be at most 80 characters")
		return
	}
	if !organisationSlug.MatchString(slug) || reservedOrganisationSlugs[slug] {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"the slug must be 3 to 40 lowercase letters, digits, or hyphens, and not a reserved word")
		return
	}
	if !organisationPrefix.MatchString(prefix) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "the issue prefix must be 2 to 6 uppercase letters")
		return
	}

	m, err := s.store.CreateWorkspaceWithFreeSlug(r.Context(), user.ID, name, slug, prefix)
	if err != nil {
		writeOrganisationError(w, err, "could not create the organisation")
		return
	}
	WriteJSON(w, http.StatusCreated, m)
}
