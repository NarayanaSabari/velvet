package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

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
	cookie, _ := r.Cookie(auth.CookieName)
	setup := r.URL.Query().Get("state")
	slug, err := s.store.CompletedGitHubSetup(r.Context(), setup, cookie.Value, user.ID, candidate)
	if err == nil {
		http.Redirect(w, r, "/w/"+slug+"/admin", http.StatusFound)
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeGitHubAuthorizationError(w, err)
		return
	}
	state, challenge, err := s.store.StartGitHubInstallationAuthorization(r.Context(), setup, cookie.Value, user.ID, candidate)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	http.Redirect(w, r, s.githubUser.AuthorizationURL(state, challenge), http.StatusFound)
}
