package config

import (
	"fmt"
	"os"
)

type Config struct {
	DatabaseURL        string
	Port               string
	SessionSecret      string
	GitHubClientID     string
	GitHubClientSecret string
	// The GitHub App settings are optional at load time, so the API still
	// boots before anyone has installed the App.
	GitHubWebhookSecret string
	GitHubAppID         string
	GitHubAppPrivateKey string
	// GitHubAPIURL points the App client somewhere other than api.github.com:
	// GitHub Enterprise in production, and a stub when the setup scripts are
	// being verified without a real organisation.
	GitHubAPIURL string
	BaseURL      string
}

func Load() (*Config, error) {
	c := &Config{
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		Port:                envOr("PORT", "8080"),
		SessionSecret:       os.Getenv("SESSION_SECRET"),
		GitHubClientID:      os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret:  os.Getenv("GITHUB_CLIENT_SECRET"),
		GitHubWebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
		GitHubAppID:         os.Getenv("GITHUB_APP_ID"),
		GitHubAppPrivateKey: os.Getenv("GITHUB_APP_PRIVATE_KEY"),
		GitHubAPIURL:        os.Getenv("GITHUB_API_URL"),
		BaseURL:             envOr("BASE_URL", "http://localhost:8080"),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if len(c.SessionSecret) < 32 {
		return nil, fmt.Errorf("SESSION_SECRET must be at least 32 characters")
	}
	return c, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
