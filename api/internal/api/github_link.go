package api

import (
	"errors"
	"net/http"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerGitHubAuthorizationRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/auth/github/link", s.RequireAuth(http.HandlerFunc(s.handleGitHubLink)))
	mux.Handle("GET /api/v1/auth/github/callback", s.RequireAuth(http.HandlerFunc(s.handleGitHubAuthorizationCallback)))
	mux.Handle("GET /api/v1/github/setup", s.RequireAuth(http.HandlerFunc(s.handleGitHubSetup)))
	mux.Handle("DELETE /api/v1/me/github", s.RequireAuth(http.HandlerFunc(s.handleGitHubUnlink)))
}

func githubPrivateResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (s *Server) handleGitHubLink(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	if s.githubUser == nil {
		WriteError(w, 503, "unavailable", "GitHub authorization is unavailable")
		return
	}
	user, _ := CurrentUser(r.Context())
	cookie, _ := r.Cookie(auth.CookieName)
	state, challenge, err := s.store.CreateGitHubLinkAuthorization(r.Context(), cookie.Value, user.ID)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	http.Redirect(w, r, s.githubUser.AuthorizationURL(state, challenge), http.StatusFound)
}

func (s *Server) handleGitHubAuthorizationCallback(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	user, _ := CurrentUser(r.Context())
	cookie, _ := r.Cookie(auth.CookieName)
	state := r.URL.Query().Get("state")
	a, err := s.store.GetGitHubAuthorization(r.Context(), state, cookie.Value, user.ID)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	if a.Completed {
		githubCompletionRedirect(w, r, a)
		return
	}
	if s.githubUser == nil || (a.Purpose == "installation" && s.completeGitHubInstallation == nil) {
		WriteError(w, 503, "unavailable", "GitHub authorization is unavailable")
		return
	}
	a, err = s.store.ClaimGitHubAuthorization(r.Context(), state, cookie.Value, user.ID, a.Purpose)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	// Claim before validating provider denial or exchanging a code. Failed
	// attempts are spent and must restart; no OAuth code is retried.
	code := r.URL.Query().Get("code")
	if r.URL.Query().Get("error") != "" || code == "" {
		WriteError(w, 400, "authorization_failed", "GitHub authorization was not completed; start again")
		return
	}
	verified, err := s.githubUser.Authorize(r.Context(), code, a.Verifier, a.CandidateInstallationID)
	a.Verifier = ""
	if err != nil {
		WriteError(w, 502, "authorization_failed", "could not verify GitHub authorization; start again")
		return
	}
	if a.Purpose == "link" {
		err = s.store.CompleteGitHubLink(r.Context(), a, store.GitHubIdentity{ID: verified.User.ID, Login: verified.User.Login})
	} else {
		err = s.completeGitHubInstallation(r.Context(), a, verified.Installation)
	}
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	// A completer must have committed a durable receipt. A nil return alone
	// cannot cause an installation success redirect.
	receipt, err := s.store.GetGitHubAuthorization(r.Context(), state, cookie.Value, user.ID)
	if err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	if !receipt.Completed {
		WriteError(w, 500, "internal", "could not complete GitHub authorization")
		return
	}
	githubCompletionRedirect(w, r, receipt)
}

func githubCompletionRedirect(w http.ResponseWriter, r *http.Request, a store.GitHubAuthorization) {
	next := "/"
	if a.Purpose == "installation" {
		next = "/w/" + a.WorkspaceSlug + "/admin"
	}
	http.Redirect(w, r, next, http.StatusFound)
}

func (s *Server) handleGitHubUnlink(w http.ResponseWriter, r *http.Request) {
	githubPrivateResponse(w)
	user, _ := CurrentUser(r.Context())
	cookie, _ := r.Cookie(auth.CookieName)
	if err := s.store.UnlinkGitHub(r.Context(), cookie.Value, user.ID); err != nil {
		writeGitHubAuthorizationError(w, err)
		return
	}
	// Drop browser HTTP caches containing the old identity. In-memory UI query
	// caches must also be invalidated by the profile mutation consumer.
	w.Header().Set("Clear-Site-Data", `"cache"`)
	WriteJSON(w, http.StatusNoContent, nil)
}

func writeGitHubAuthorizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrInstallationConflict):
		WriteError(w, 409, "installation_conflict", "the installation or organisation already has another connection")
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, 410, "expired", "this GitHub authorization is expired or already used; start again")
	case errors.Is(err, store.ErrDuplicate):
		WriteError(w, 409, "conflict", "that GitHub account is already linked to another user")
	case errors.Is(err, store.ErrForeignReference):
		WriteError(w, 409, "conflict", "that installation is already connected to another organisation")
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, 403, "forbidden", "organisation administrator access is required")
	default:
		WriteError(w, 500, "internal", "could not complete GitHub authorization")
	}
}
