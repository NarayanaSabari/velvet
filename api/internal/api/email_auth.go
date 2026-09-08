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

func (s *Server) handleEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	email, err := store.NormalizeEmail(body.Email)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "a valid email address is required")
		return
	}
	ip, err := s.clientIP(r)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "invalid client address")
		return
	}
	token, err := s.store.IssueLoginToken(r.Context(), email, ip, nil)
	if err != nil && !errors.Is(err, store.ErrRateLimited) {
		WriteError(w, http.StatusInternalServerError, "internal", "could not request sign-in")
		return
	}
	if err == nil {
		if s.mailer == nil {
			WriteError(w, http.StatusInternalServerError, "internal", "mail is not configured")
			return
		}
		link := strings.TrimRight(s.cfg.BaseURL, "/") + "/signin/confirm#token=" + token
		if err := s.mailer.Send(r.Context(), mail.SignInMessage(email, link)); err != nil {
			// Issuance is committed: retain its counter and never retry here.
			// Provider errors may contain recipients or secrets, so omit them.
			slog.Error("sign-in mail delivery failed", "request_id", r.Context().Value(requestIDKey))
		}
	}
	WriteJSON(w, http.StatusAccepted, map[string]string{"status": "sent"})
}

func (s *Server) handleMagic(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	result, err := s.store.ConfirmLogin(r.Context(), body.Token)
	if errors.Is(err, store.ErrNotFound) {
		WriteError(w, http.StatusGone, "expired", "the sign-in link has expired")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not confirm sign-in")
		return
	}
	auth.SetSessionCookie(w, result.SessionToken, s.secureCookies())
	WriteJSON(w, http.StatusOK, map[string]string{"next": result.Next})
}
