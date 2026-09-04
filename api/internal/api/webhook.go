package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
)

// maxWebhookBody is GitHub's documented ceiling for a delivery payload.
const maxWebhookBody = 25 << 20

// handleGitHubWebhook verifies, stores, and returns. It deliberately does no
// matching and calls GitHub not at all: the worker owns the real work, so a
// slow database or a GitHub outage can never make deliveries time out.
func (s *Server) handleGitHubWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBody+1))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "could not read the body")
		return
	}
	if len(body) > maxWebhookBody {
		WriteError(w, http.StatusRequestEntityTooLarge, "too_large", "payload too large")
		return
	}

	// Verify before parsing: an unverified payload is attacker-controlled and
	// must not reach the database or the JSON decoder's edge cases.
	if !validSignature(s.cfg.GitHubWebhookSecret, body, r.Header.Get("X-Hub-Signature-256")) {
		WriteError(w, http.StatusUnauthorized, "bad_signature", "signature did not verify")
		return
	}

	deliveryID := r.Header.Get("X-GitHub-Delivery")
	eventType := r.Header.Get("X-GitHub-Event")
	if deliveryID == "" || eventType == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "missing GitHub headers")
		return
	}

	isNew, err := s.store.RecordDelivery(r.Context(), deliveryID, eventType, body)
	if err != nil {
		// 500 makes GitHub retry, which is what we want when storage failed.
		slog.Error("record delivery", "err", err, "delivery", deliveryID)
		WriteError(w, http.StatusInternalServerError, "internal", "could not accept the delivery")
		return
	}

	// A duplicate still answers 200, because GitHub should stop retrying
	// something already accepted.
	WriteJSON(w, http.StatusOK, map[string]any{"accepted": true, "duplicate": !isNew})
}

// validSignature compares in constant time. A plain == would leak the correct
// prefix length through timing.
func validSignature(secret string, body []byte, header string) bool {
	if secret == "" || header == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(header))
}
