package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerInviteRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/me/invites", s.RequireAuth(http.HandlerFunc(s.handleMyInvites)))
	mux.Handle("POST /api/v1/me/invites/{id}/accept", s.RequireAuth(http.HandlerFunc(s.handleAcceptMyInvite)))
	mux.HandleFunc("POST /api/v1/invite/preview", s.handlePreviewInvite)
	mux.HandleFunc("POST /api/v1/invite/accept", s.handleAcceptInvite)
	admin := RequireRole("admin")
	mux.Handle("GET /api/v1/w/{slug}/invites", s.RequireWorkspace(admin(http.HandlerFunc(s.handleWorkspaceInvites))))
	mux.Handle("POST /api/v1/w/{slug}/invites", s.RequireWorkspace(admin(http.HandlerFunc(s.handleCreateInvite))))
	mux.Handle("POST /api/v1/w/{slug}/invites/{id}/resend", s.RequireWorkspace(admin(http.HandlerFunc(s.handleResendInvite))))
	mux.Handle("DELETE /api/v1/w/{slug}/invites/{id}", s.RequireWorkspace(admin(http.HandlerFunc(s.handleRevokeInvite))))
}

func (s *Server) handleMyInvites(w http.ResponseWriter, r *http.Request) {
	u, _ := CurrentUser(r.Context())
	invites, err := s.store.ListMyInvites(r.Context(), u.ID)
	if err != nil {
		writeOrganisationError(w, err, "could not list invitations")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (s *Server) handleWorkspaceInvites(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	invites, err := s.store.ListWorkspaceInvites(r.Context(), ws.WorkspaceID)
	if err != nil {
		writeOrganisationError(w, err, "could not list invitations")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	email, err := store.NormalizeEmail(body.Email)
	if err != nil || !validMembershipRole(body.Role) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "a valid email and role of admin, member, or viewer are required")
		return
	}
	if s.mailer == nil {
		WriteError(w, http.StatusInternalServerError, "internal", "mail is not configured")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	i, token, err := s.store.CreateInvite(r.Context(), ws.WorkspaceID, user.ID, email, body.Role)
	if err != nil {
		writeOrganisationError(w, err, "could not create the invitation")
		return
	}
	s.sendInvitation(r, user, i, token)
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	WriteJSON(w, http.StatusCreated, i)
}

func (s *Server) handleResendInvite(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if s.mailer == nil {
		WriteError(w, http.StatusInternalServerError, "internal", "mail is not configured")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	i, token, err := s.store.ReplaceInvite(r.Context(), ws.WorkspaceID, id, user.ID, "")
	if err != nil {
		writeOrganisationError(w, err, "could not resend the invitation")
		return
	}
	s.sendInvitation(r, user, i, token)
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	WriteJSON(w, http.StatusOK, i)
}

func (s *Server) sendInvitation(r *http.Request, user store.User, i store.Invite, token string) {
	inviter := user.Name
	if inviter == "" {
		inviter = user.Email
	}
	link := strings.TrimRight(s.cfg.BaseURL, "/") + "/invite#token=" + token
	if err := s.mailer.Send(r.Context(), mail.InviteMessage(i.Email, i.WorkspaceName, inviter, link)); err != nil {
		slog.Error("invitation mail delivery failed", "request_id", r.Context().Value(requestIDKey))
	}
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	if err := s.store.RevokeInvite(r.Context(), ws.WorkspaceID, id, user.ID); err != nil {
		writeOrganisationError(w, err, "could not revoke the invitation")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	w.WriteHeader(http.StatusNoContent)
}

// An absent or stale session is anonymous on the public invitation page.
func (s *Server) inviteUser(r *http.Request) (store.User, bool, error) {
	cookie, err := r.Cookie(auth.CookieName)
	if errors.Is(err, http.ErrNoCookie) {
		return store.User{}, false, nil
	}
	if err != nil {
		return store.User{}, false, err
	}
	u, err := s.store.UserBySessionToken(r.Context(), cookie.Value)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, false, nil
	}
	return u, err == nil, err
}

func (s *Server) handlePreviewInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	i, err := s.store.PreviewInviteToken(r.Context(), body.Token)
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	u, signedIn, err := s.inviteUser(r)
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	email, _ := store.NormalizeEmail(u.Email)
	invitedEmail, _ := store.NormalizeEmail(i.Email)
	WriteJSON(w, http.StatusOK, map[string]any{"invite": i, "signed_in": signedIn, "email_matches": signedIn && email == invitedEmail})
}

func (s *Server) handleAcceptInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	i, err := s.store.PreviewInviteToken(r.Context(), body.Token)
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	u, signedIn, err := s.inviteUser(r)
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	if !signedIn {
		s.issueEmailSignIn(w, r, i.Email, &i.ID)
		return
	}
	m, err := s.store.AcceptInviteToken(r.Context(), body.Token, u.ID)
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	s.rememberAcceptedInvite(w, r, m)
}

func (s *Server) handleAcceptMyInvite(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	u, _ := CurrentUser(r.Context())
	m, err := s.store.AcceptMyInvite(r.Context(), id, u.ID)
	if errors.Is(err, store.ErrForbidden) {
		WriteError(w, http.StatusNotFound, "not_found", "no such invitation")
		return
	}
	if err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	s.rememberAcceptedInvite(w, r, m)
}

func (s *Server) rememberAcceptedInvite(w http.ResponseWriter, r *http.Request, m store.Membership) {
	cookie, _ := r.Cookie(auth.CookieName)
	if err := s.store.RememberWorkspace(r.Context(), cookie.Value, m.WorkspaceID); err != nil {
		writeInviteAcceptanceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, m)
}

func writeInviteAcceptanceError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		WriteError(w, http.StatusGone, "expired", "the invitation has expired")
		return
	}
	writeOrganisationError(w, err, "could not read or accept the invitation")
}
