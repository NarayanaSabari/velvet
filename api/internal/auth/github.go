package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func OAuthConfig(clientID, clientSecret, baseURL string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  baseURL + "/api/v1/auth/github/callback",
		Scopes:       []string{"read:user"},
		Endpoint:     github.Endpoint,
	}
}

// FetchIdentity asks GitHub who the freshly authorised token belongs to.
func FetchIdentity(ctx context.Context, cfg *oauth2.Config, tok *oauth2.Token) (store.GitHubIdentity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return store.GitHubIdentity{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := cfg.Client(ctx, tok).Do(req)
	if err != nil {
		return store.GitHubIdentity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return store.GitHubIdentity{}, fmt.Errorf("github /user returned %d", resp.StatusCode)
	}

	var payload struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return store.GitHubIdentity{}, err
	}
	return store.GitHubIdentity{
		ID: payload.ID, Login: payload.Login,
		Name: payload.Name, AvatarURL: payload.AvatarURL,
	}, nil
}
