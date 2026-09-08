package github

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Authorization errors deliberately contain no request URL or provider body.
var ErrUserAuthorization = errors.New("github user authorization failed")

type UserClientConfig struct {
	ClientID, ClientSecret                          string
	AuthorizationURL, TokenURL, APIURL, RedirectURL string
}

type UserClient struct {
	cfg  UserClientConfig
	http *http.Client
}
type AuthorizedUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}
type VerifiedInstallation struct {
	ID, AccountID             int64
	AccountLogin, AccountType string
}
type UserAuthorization struct {
	User         AuthorizedUser
	Installation VerifiedInstallation
}

func NewUserClient(cfg UserClientConfig) (*UserClient, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, ErrUserAuthorization
	}
	if cfg.AuthorizationURL == "" {
		cfg.AuthorizationURL = "https://github.com/login/oauth/authorize"
	}
	if cfg.TokenURL == "" {
		cfg.TokenURL = "https://github.com/login/oauth/access_token"
	}
	if cfg.APIURL == "" {
		cfg.APIURL = defaultBaseURL
	}
	cfg.APIURL = strings.TrimRight(cfg.APIURL, "/")
	for _, raw := range []string{cfg.AuthorizationURL, cfg.TokenURL, cfg.APIURL, cfg.RedirectURL} {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, ErrUserAuthorization
		}
	}
	return &UserClient{cfg: cfg, http: &http.Client{Timeout: requestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *UserClient) AuthorizationURL(state, challenge string) string {
	q := url.Values{"client_id": {c.cfg.ClientID}, "redirect_uri": {c.cfg.RedirectURL}, "state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	return c.cfg.AuthorizationURL + "?" + q.Encode()
}

// Authorize keeps the temporary access token within this call. Refresh tokens
// are ignored, and neither identity lookup nor installation checks use App JWTs.
func (c *UserClient) Authorize(ctx context.Context, code, verifier string, candidate int64) (UserAuthorization, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var result UserAuthorization
	form := url.Values{"client_id": {c.cfg.ClientID}, "client_secret": {c.cfg.ClientSecret}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {c.cfg.RedirectURL}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return result, ErrUserAuthorization
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Error       string `json:"error"`
	}
	if _, err = c.request(req, &token); err != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") || token.Error != "" {
		return result, ErrUserAuthorization
	}
	if _, err = c.get(ctx, c.cfg.APIURL+"/user", token.AccessToken, &result.User); err != nil || result.User.ID <= 0 || result.User.Login == "" {
		return UserAuthorization{}, ErrUserAuthorization
	}
	if candidate == 0 {
		return result, nil
	}
	installation, err := c.verifyInstallation(ctx, token.AccessToken, result.User.ID, candidate)
	if err != nil {
		return UserAuthorization{}, err
	}
	result.Installation = installation
	return result, nil
}

func (c *UserClient) verifyInstallation(ctx context.Context, token string, userID, candidate int64) (VerifiedInstallation, error) {
	var found VerifiedInstallation
	next := c.cfg.APIURL + "/user/installations?per_page=100"
	seen := map[string]bool{}
	ids := map[int64]bool{}
	total := -1
	for next != "" {
		if seen[next] || len(seen) >= 100 {
			return found, ErrUserAuthorization
		}
		seen[next] = true
		var page struct {
			Total         *int `json:"total_count"`
			Installations *[]struct {
				ID      int64 `json:"id"`
				Account struct {
					ID    int64  `json:"id"`
					Login string `json:"login"`
					Type  string `json:"type"`
				} `json:"account"`
			} `json:"installations"`
		}
		link, err := c.get(ctx, next, token, &page)
		if err != nil || page.Total == nil || *page.Total < 0 || page.Installations == nil {
			return found, ErrUserAuthorization
		}
		if total < 0 {
			total = *page.Total
		}
		if *page.Total != total {
			return found, ErrUserAuthorization
		}
		for _, item := range *page.Installations {
			if item.ID <= 0 || item.Account.ID <= 0 || item.Account.Login == "" || (item.Account.Type != "User" && item.Account.Type != "Organization") || ids[item.ID] {
				return found, ErrUserAuthorization
			}
			ids[item.ID] = true
			if item.ID == candidate {
				found = VerifiedInstallation{ID: item.ID, AccountID: item.Account.ID, AccountLogin: item.Account.Login, AccountType: item.Account.Type}
			}
		}
		next, err = c.next(link, "/user/installations")
		if err != nil {
			return found, err
		}
	}
	if len(ids) != total || found.ID == 0 {
		return found, ErrUserAuthorization
	}
	if found.AccountType == "User" {
		if found.AccountID != userID {
			return found, ErrUserAuthorization
		}
		return found, nil
	}
	next = c.cfg.APIURL + "/user/memberships/orgs?per_page=100"
	seen = map[string]bool{}
	orgIDs := map[int64]bool{}
	admin := false
	for next != "" {
		if seen[next] || len(seen) >= 100 {
			return found, ErrUserAuthorization
		}
		seen[next] = true
		var page *[]struct {
			State        string `json:"state"`
			Role         string `json:"role"`
			Organization struct {
				ID int64 `json:"id"`
			} `json:"organization"`
		}
		link, err := c.get(ctx, next, token, &page)
		if err != nil || page == nil {
			return found, ErrUserAuthorization
		}
		for _, m := range *page {
			if m.Organization.ID <= 0 || orgIDs[m.Organization.ID] || (m.State != "active" && m.State != "pending") || (m.Role != "admin" && m.Role != "member") {
				return found, ErrUserAuthorization
			}
			orgIDs[m.Organization.ID] = true
			if m.Organization.ID == found.AccountID && m.State == "active" && m.Role == "admin" {
				admin = true
			}
		}
		next, err = c.next(link, "/user/memberships/orgs")
		if err != nil {
			return found, err
		}
	}
	if !admin {
		return found, ErrUserAuthorization
	}
	return found, nil
}

func (c *UserClient) get(ctx context.Context, address, token string, out any) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return "", ErrUserAuthorization
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
	return c.request(req, out)
}

func (c *UserClient) request(req *http.Request, out any) (string, error) {
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", ErrUserAuthorization
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", ErrUserAuthorization
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024+1))
	if err != nil || len(body) > 2*1024*1024 || json.Unmarshal(body, out) != nil {
		return "", ErrUserAuthorization
	}
	return strings.Join(resp.Header.Values("Link"), ","), nil
}

// Every pagination target stays on the configured API origin and endpoint.
// Reject malformed links even after finding an owner: partial lists grant nothing.
func (c *UserClient) next(header, endpoint string) (string, error) {
	if header == "" {
		return "", nil
	}
	base, _ := url.Parse(c.cfg.APIURL)
	next := ""
	for _, part := range strings.Split(header, ",") {
		bits := strings.Split(strings.TrimSpace(part), ";")
		if len(bits) < 2 || !strings.HasPrefix(bits[0], "<") || !strings.HasSuffix(bits[0], ">") {
			return "", ErrUserAuthorization
		}
		target, err := url.Parse(strings.TrimSuffix(strings.TrimPrefix(bits[0], "<"), ">"))
		if err != nil {
			return "", ErrUserAuthorization
		}
		target = base.ResolveReference(target)
		if target.Scheme != base.Scheme || target.Host != base.Host || target.User != nil || target.Fragment != "" || target.Path != base.Path+endpoint {
			return "", ErrUserAuthorization
		}
		relation := ""
		for _, attr := range bits[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(attr), "=")
			if !ok {
				return "", ErrUserAuthorization
			}
			if strings.TrimSpace(key) == "rel" {
				if relation != "" {
					return "", ErrUserAuthorization
				}
				relation = strings.Trim(strings.TrimSpace(value), `"`)
			}
		}
		switch relation {
		case "next":
			if next != "" {
				return "", ErrUserAuthorization
			}
			next = target.String()
		case "prev", "first", "last":
		default:
			return "", ErrUserAuthorization
		}
	}
	return next, nil
}
