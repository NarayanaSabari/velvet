package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

const userKey ctxKey = "user"
const workspaceKey ctxKey = "workspace"
const authMethodKey ctxKey = "auth_method"
const apiTokenKey ctxKey = "api_token"

type authMethod string

const (
	authMethodCookie authMethod = "cookie"
	authMethodBearer authMethod = "bearer"
)

func CurrentUser(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

func CurrentWorkspace(ctx context.Context) (store.Membership, bool) {
	m, ok := ctx.Value(workspaceKey).(store.Membership)
	return m, ok
}

func isBearerAuth(ctx context.Context) bool {
	return ctx.Value(authMethodKey) == authMethodBearer
}

// currentAPIToken identifies the agent token that authenticated the request,
// so a work-log entry can record which agent wrote it. A browser session has
// none.
func currentAPIToken(ctx context.Context) *uuid.UUID {
	id, ok := ctx.Value(apiTokenKey).(uuid.UUID)
	if !ok || id == uuid.Nil {
		return nil
	}
	return &id
}

// commentSource reports who is writing. It is derived from how the request
// authenticated rather than from anything the client sent, so a caller cannot
// mark its own entry as human or agent.
func commentSource(ctx context.Context) string {
	if isBearerAuth(ctx) {
		return "agent"
	}
	return "human"
}

// bearerTokenFromRequest recognizes the explicit bearer contract. A malformed
// bearer value still counts as bearer auth so it cannot fall back to a browser
// cookie supplied on the same request.
func bearerTokenFromRequest(r *http.Request) (string, bool) {
	values := r.Header.Values("Authorization")
	if len(values) == 0 {
		return "", false
	}
	if len(values) != 1 {
		for _, value := range values {
			scheme, _, ok := strings.Cut(strings.TrimSpace(value), " ")
			if (ok || strings.EqualFold(strings.TrimSpace(value), "Bearer")) && strings.EqualFold(scheme, "Bearer") {
				return "", true
			}
		}
		return "", false
	}
	value := strings.TrimSpace(values[0])
	scheme, token, ok := strings.Cut(value, " ")
	if !ok {
		return "", strings.EqualFold(value, "Bearer")
	}
	if !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	return strings.TrimSpace(token), true
}

func sessionTokenFromRequest(r *http.Request) (string, bool) {
	if isBearerAuth(r.Context()) {
		return "", false
	}
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	return cookie.Value, true
}

func requireBrowserSession(w http.ResponseWriter, r *http.Request) (string, bool) {
	if session, ok := sessionTokenFromRequest(r); ok {
		return session, true
	}
	WriteError(w, http.StatusForbidden, "forbidden", "a browser session is required for this operation")
	return "", false
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
	w.Header().Set("Cache-Control", "no-store")
	user, _ := CurrentUser(r.Context())
	memberships, err := s.store.MembershipsForUser(r.Context(), user.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read membership")
		return
	}
	var last *store.Membership
	if session, ok := sessionTokenFromRequest(r); ok {
		last, err = s.store.LastWorkspace(r.Context(), session)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "internal", "could not read the last organisation")
			return
		}
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
		if token, ok := bearerTokenFromRequest(r); ok {
			user, tokenID, err := s.store.LookupAPIToken(r.Context(), token)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					WriteError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
					return
				}
				WriteError(w, http.StatusInternalServerError, "internal", "could not read the API token")
				return
			}
			ctx := context.WithValue(r.Context(), userKey, user)
			ctx = context.WithValue(ctx, authMethodKey, authMethodBearer)
			ctx = context.WithValue(ctx, apiTokenKey, tokenID)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
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
		ctx := context.WithValue(r.Context(), userKey, user)
		ctx = context.WithValue(ctx, authMethodKey, authMethodCookie)
		next.ServeHTTP(w, r.WithContext(ctx))
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
		remember := func() {}
		if session, ok := sessionTokenFromRequest(r); ok {
			remember = func() {
				if err := s.store.RememberWorkspace(r.Context(), session, m.WorkspaceID); err != nil {
					// The handler may already have committed a mutation. A failed
					// preference update must not replace its successful response.
					slog.Error("could not remember organisation", "request_id", r.Context().Value(requestIDKey))
				}
			}
		}
		response := &workspaceResponseWriter{ResponseWriter: w, remember: remember}
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
