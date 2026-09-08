package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

const userKey ctxKey = "user"
const workspaceKey ctxKey = "workspace"

func CurrentUser(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

func CurrentWorkspace(ctx context.Context) (store.Membership, bool) {
	m, ok := ctx.Value(workspaceKey).(store.Membership)
	return m, ok
}

func (s *Server) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/email", s.handleEmail)
	mux.HandleFunc("POST /api/v1/auth/magic", s.handleMagic)
	mux.HandleFunc("GET /api/v1/auth/magic", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		WriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST is required")
	})
	// Logout is deliberately idempotent. It must clear a stale browser cookie
	// even when the backing session has expired or was already removed.
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.Handle("GET /api/v1/me", s.RequireAuth(http.HandlerFunc(s.handleMe)))
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
	cookie, _ := r.Cookie(auth.CookieName)
	last, err := s.store.LastWorkspace(r.Context(), cookie.Value)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the last organisation")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"user":           user,
		"memberships":    memberships,
		"last_workspace": last,
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
		cookie, _ := r.Cookie(auth.CookieName)
		response := &workspaceResponseWriter{ResponseWriter: w, remember: func() {
			if err := s.store.RememberWorkspace(r.Context(), cookie.Value, m.WorkspaceID); err != nil {
				// The handler may already have committed a mutation. A failed
				// preference update must not replace its successful response.
				slog.Error("could not remember organisation", "request_id", r.Context().Value(requestIDKey))
			}
		}}
		next.ServeHTTP(response, r.WithContext(context.WithValue(r.Context(), workspaceKey, m)))
		if !response.wroteHeader {
			response.WriteHeader(http.StatusOK)
		}
	}))
}

// Remember at the first successful response, including an SSE connection's
// initial flush. Waiting for the handler to return would defer streaming
// persistence until disconnect; resolving membership alone also counts errors.
type workspaceResponseWriter struct {
	http.ResponseWriter
	remember    func()
	wroteHeader bool
}

func (w *workspaceResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.wroteHeader = true
	if status >= 200 && status < 300 {
		w.remember()
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *workspaceResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *workspaceResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
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
