package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/mail"
	"net/netip"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	loginTokenBytes = 32
	loginTokenTTL   = "15 minutes"
	loginEmailLimit = 5
	loginIPLimit    = 20
)

// NormalizeEmail returns a trimmed, lowercase mailbox suitable for login
// issuance. It deliberately rejects display names and address lists because a
// login link must be sent to one mailbox only.
func NormalizeEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return "", ErrInvalidEmail
	}
	return email, nil
}

// NormalizeIP returns netip's canonical address form. Unmapping IPv4-mapped
// IPv6 addresses gives both presentations the same rate-limit bucket.
func NormalizeIP(ip string) (string, error) {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return "", ErrInvalidIP
	}
	return addr.Unmap().String(), nil
}

// IssueLoginToken records a short-lived, single-use login token. The raw
// token is returned only to the caller that sends the mail; the database holds
// its SHA-256 hash. Issuance never creates an app_user before confirmation.
func (s *Store) IssueLoginToken(ctx context.Context, email, ip string, inviteID *uuid.UUID) (string, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return "", err
	}
	ip, err = NormalizeIP(ip)
	if err != nil {
		return "", err
	}

	raw := make([]byte, loginTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate login token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			SELECT pg_advisory_xact_lock(hashtextextended('login-email:' || $1, 0))`, email); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			SELECT pg_advisory_xact_lock(hashtextextended('login-ip:' || $1, 0))`, ip); err != nil {
			return err
		}

		var emailCount int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM login_token
			WHERE lower(email) = $1 AND created_at > now() - interval '15 minutes'`, email).Scan(&emailCount); err != nil {
			return err
		}
		if emailCount >= loginEmailLimit {
			return ErrRateLimited
		}

		var ipCount int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM login_token
			WHERE request_ip = $1 AND created_at > now() - interval '15 minutes'`, ip).Scan(&ipCount); err != nil {
			return err
		}
		if ipCount >= loginIPLimit {
			return ErrRateLimited
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO login_token (email, token_hash, request_ip, invite_id, expires_at)
			VALUES ($1, $2, $3, $4, now() + $5::interval)`,
			email, HashToken(token), ip, inviteID, loginTokenTTL)
		return err
	})
	if err != nil {
		return "", err
	}
	return token, nil
}
