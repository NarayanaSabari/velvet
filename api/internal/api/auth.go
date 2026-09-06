package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

const userKey ctxKey = "user"
const workspaceKey ctxKey = "workspace"
const oauthStateCookie = "ticket_oauth_state"

func CurrentUser(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

func CurrentWorkspace(ctx context.Context) (store.Membership, bool) {
	m, ok := ctx.Value(workspaceKey).(store.Membership)
	return m, ok
}

func (s *Server) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/auth/github/login", s.handleLogin)
	mux.HandleFunc("GET /api/v1/auth/github/callback", s.handleCallback)
	// Logout is deliberately idempotent. It must clear a stale browser cookie
	// even when the backing session has expired or was already removed.
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.Handle("GET /api/v1/me", s.RequireAuth(http.HandlerFunc(s.handleMe)))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not start sign-in")
		return
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/",
		HttpOnly: true, Secure: s.secureCookies(), SameSite: http.SameSiteLaxMode,
		Expires: time.Now().Add(10 * time.Minute),
	})
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	http.Redirect(w, r, cfg.AuthCodeURL(state), http.StatusFound)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(oauthStateCookie)
	if err != nil || cookie.Value == "" || cookie.Value != r.URL.Query().Get("state") {
		WriteError(w, http.StatusBadRequest, "invalid_state", "sign-in state did not match")
		return
	}
	cfg := auth.OAuthConfig(s.cfg.GitHubClientID, s.cfg.GitHubClientSecret, s.cfg.BaseURL)
	tok, err := cfg.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "exchange_failed", "could not complete sign-in")
		return
	}
	identity, err := auth.FetchIdentity(r.Context(), cfg, tok)
	if err != nil {
		WriteError(w, http.StatusBadGateway, "github_unavailable", "could not reach GitHub")
		return
	}

	user, err := s.store.UpsertUserByGitHub(r.Context(), identity)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not record the account")
		return
	}
	if _, err := s.store.BindMembership(r.Context(), user.ID, user.GitHubLogin); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not bind membership")
		return
	}
	memberships, err := s.store.MembershipsForUser(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read membership")
		return
	}
	// An uninvited GitHub account gets no session at all: discovering the URL
	// must not be enough to obtain an account.
	if len(memberships) == 0 {
		http.Redirect(w, r, "/not-invited", http.StatusFound)
		return
	}

	token, err := s.store.CreateSession(r.Context(), user.ID, auth.SessionTTL)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create a session")
		return
	}
	auth.SetSessionCookie(w, token, s.secureCookies())
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		if err := s.store.DeleteSession(r.Context(), c.Value); err != nil {
			WriteError(w, http.StatusInternalServerError, "internal", "could not end the session")
			return
		}
	}
	auth.ClearSessionCookie(w, s.secureCookies())
	WriteJSON(w, http.StatusOK, map[string]string{"status": "signed_out"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := CurrentUser(r.Context())
	memberships, err := s.store.MembershipsForUser(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read membership")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"user":        user,
		"memberships": memberships,
	})
}

func (s *Server) secureCookies() bool {
	return strings.HasPrefix(s.cfg.BaseURL, "https://")
}

func (s *Server) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(auth.CookieName)
		if err != nil || c.Value == "" {
			WriteError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		user, err := s.store.UserBySessionToken(r.Context(), c.Value)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				WriteError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
				return
			}
			WriteError(w, http.StatusInternalServerError, "internal", "could not read the session")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

// RequireWorkspace resolves {slug} into a membership and rejects anyone who is
// not a member. Every workspace-scoped route sits behind this.
func (s *Server) RequireWorkspace(next http.Handler) http.Handler {
	return s.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, _ := CurrentUser(r.Context())
		m, err := s.store.MembershipForSlug(r.Context(), user.ID, r.PathValue("slug"))
		if err != nil {
			WriteError(w, http.StatusNotFound, "not_found", "no such workspace")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workspaceKey, m)))
	}))
}

// RequireRole wraps a handler so that viewers cannot mutate.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(roles))
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			m, ok := CurrentWorkspace(r.Context())
			if !ok || !allowed[m.Role] {
				WriteError(w, http.StatusForbidden, "forbidden", "insufficient permission")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
