package api

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) handleGitHubConnect(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	if s.githubUser == nil || s.completeGitHubInstallation == nil || (s.cfg.GitHubAppSlug == "" && s.cfg.GitHubInstallationURL == "") {
		WriteError(w, 503, "unavailable", "GitHub installation connection is unavailable")
		return
	}
	target := s.cfg.GitHubInstallationURL
	if target == "" {
		target = "https://github.com/apps/" + url.PathEscape(s.cfg.GitHubAppSlug) + "/installations/new"
	}
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" {
		WriteError(w, 503, "unavailable", "GitHub installation connection is unavailable")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	session, ok := requireBrowserSession(w, r)
	if !ok {
		return
	}
	state, err := s.store.CreateGitHubSetup(r.Context(), session, user.ID, ws.WorkspaceID)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	q := u.Query()
	q.Set("state", state)
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func (s *Server) handleGitHubStatus(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	ws, _ := CurrentWorkspace(r.Context())
	status, err := s.store.GitHubStatus(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, 500, "internal", "could not read GitHub connection")
		return
	}
	WriteJSON(w, 200, status)
}

func (s *Server) handleGitHubSync(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	err := s.store.RequestInstallationSync(r.Context(), ws.WorkspaceID, user.ID)
	switch {
	case errors.Is(err, store.ErrVerificationRequired):
		WriteError(w, 409, "verification_required", "verify installation ownership to sync repositories")
	case errors.Is(err, store.ErrStaleInstallationSync):
		WriteError(w, 409, "unavailable", "the installation is disconnected or suspended")
	case err != nil:
		writeStoreError(w, err, "GitHub installation")
	default:
		WriteJSON(w, 202, map[string]string{"status": "syncing"})
	}
}

func (s *Server) handleGitHubSetup(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	if s.githubUser == nil || s.completeGitHubInstallation == nil {
		WriteError(w, 503, "unavailable", "GitHub installation connection is unavailable")
		return
	}
	candidate, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	if err != nil || candidate <= 0 {
		WriteError(w, 400, "invalid_request", "a valid installation_id is required")
		return
	}
	user, _ := CurrentUser(r.Context())
	session, ok := requireBrowserSession(w, r)
	if !ok {
		return
	}
	setup := r.URL.Query().Get("state")
	slug, err := s.store.CompletedGitHubSetup(r.Context(), setup, session, user.ID, candidate)
	if err == nil {
		http.Redirect(w, r, "/w/"+slug+"/admin", http.StatusFound)
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeGitHubAuthorizationError(w, err)
		return
	}
	state, challenge, err := s.store.StartGitHubInstallationAuthorization(r.Context(), setup, session, user.ID, candidate)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	http.Redirect(w, r, s.githubUser.AuthorizationURL(state, challenge), http.StatusFound)
}
