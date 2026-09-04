// Package github is a small GitHub App REST client: it mints App JWTs,
// exchanges them for installation tokens, and reads the pull request and
// review data the work-log mirrors onto an issue timeline.
//
// Installation tokens are credentials. They are never logged and never
// included in an error message, so a leaked log line cannot become repository
// write access.
package github

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// tokenRefreshWindow is how long before expiry a cached installation token is
// treated as spent. GitHub issues them for an hour; renewing five minutes
// early keeps a long request from failing on a token that expires mid-flight.
const tokenRefreshWindow = 5 * time.Minute

// appJWTLifetime is the App JWT validity. GitHub rejects anything over ten
// minutes, so nine leaves room for the backdated iat below.
const appJWTLifetime = 9 * time.Minute

// clockSkew backdates iat. GitHub rejects a token issued in its future, and
// small clock differences between hosts are ordinary.
const clockSkew = 60 * time.Second

type cachedToken struct {
	token     string
	expiresAt time.Time
}

// appJWT returns a short-lived RS256 assertion identifying the App itself,
// which is the only credential accepted by the token-minting endpoint.
func (c *Client) appJWT(now time.Time) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.RegisteredClaims{
		Issuer:    c.appID,
		IssuedAt:  jwt.NewNumericDate(now.Add(-clockSkew)),
		ExpiresAt: jwt.NewNumericDate(now.Add(appJWTLifetime)),
	})
	signed, err := tok.SignedString(c.privateKey)
	if err != nil {
		return "", fmt.Errorf("github: sign app jwt: %w", err)
	}
	return signed, nil
}

// parsePrivateKey accepts either PKCS#1 ("RSA PRIVATE KEY") or PKCS#8
// ("PRIVATE KEY") PEM, since GitHub hands out the former and key management
// tools often re-wrap it as the latter.
func parsePrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	key, err := jwt.ParseRSAPrivateKeyFromPEM(pemBytes)
	if err != nil {
		return nil, fmt.Errorf("github: parse private key: %w", err)
	}
	return key, nil
}

// InstallationToken returns a token scoped to one installation, minting a new
// one only when there is no live cached token. Callers hit this on every
// request, so an uncached implementation would burn the App's own rate limit.
func (c *Client) InstallationToken(ctx context.Context, installationID int64) (string, error) {
	now := time.Now()

	c.mu.Lock()
	if t, ok := c.tokens[installationID]; ok && now.Before(t.expiresAt.Add(-tokenRefreshWindow)) {
		c.mu.Unlock()
		return t.token, nil
	}
	c.mu.Unlock()

	// Minted outside the lock so a slow GitHub call does not block readers
	// holding live tokens for other installations. A rare duplicate mint under
	// a race is cheaper than serialising every caller behind one HTTP round
	// trip; the second write simply wins.
	fresh, err := c.mintInstallationToken(ctx, installationID, now)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	c.tokens[installationID] = fresh
	c.mu.Unlock()

	return fresh.token, nil
}

func (c *Client) mintInstallationToken(ctx context.Context, installationID int64, now time.Time) (cachedToken, error) {
	assertion, err := c.appJWT(now)
	if err != nil {
		return cachedToken{}, err
	}

	url := fmt.Sprintf("%s/app/installations/%d/access_tokens", c.baseURL, installationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return cachedToken{}, fmt.Errorf("github: build token request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+assertion)
	setCommonHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return cachedToken{}, fmt.Errorf("github: mint installation token: %w", err)
	}
	defer resp.Body.Close()

	if err := checkResponse(resp); err != nil {
		return cachedToken{}, err
	}

	var body struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return cachedToken{}, fmt.Errorf("github: decode installation token: %w", err)
	}
	if body.Token == "" {
		// Deliberately reports absence, never the value.
		return cachedToken{}, fmt.Errorf("github: installation %d returned an empty token", installationID)
	}
	if body.ExpiresAt.IsZero() {
		body.ExpiresAt = now.Add(time.Hour)
	}
	return cachedToken{token: body.Token, expiresAt: body.ExpiresAt}, nil
}
