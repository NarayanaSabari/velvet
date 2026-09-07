package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	DatabaseURL        string
	Port               string
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
	// Mail is required in production so sign-in cannot silently fall back to
	// logging links; locally the log mailer is the point.
	ResendAPIKey string
	MailFrom     string
	// The App's URL slug, used to send admins to its installation page.
	GitHubAppSlug string
}

func Load() (*Config, error) {
	c := &Config{
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		Port:                envOr("PORT", "8080"),
		GitHubClientID:      os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret:  os.Getenv("GITHUB_CLIENT_SECRET"),
		GitHubWebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
		GitHubAppID:         os.Getenv("GITHUB_APP_ID"),
		GitHubAppPrivateKey: os.Getenv("GITHUB_APP_PRIVATE_KEY"),
		GitHubAPIURL:        os.Getenv("GITHUB_API_URL"),
		BaseURL:             envOr("BASE_URL", "http://localhost:8080"),
	}
	c.ResendAPIKey = os.Getenv("RESEND_API_KEY")
	c.MailFrom = os.Getenv("MAIL_FROM")
	c.GitHubAppSlug = os.Getenv("GITHUB_APP_SLUG")
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if strings.HasPrefix(c.BaseURL, "https://") && (c.ResendAPIKey == "" || c.MailFrom == "") {
		return nil, fmt.Errorf("RESEND_API_KEY and MAIL_FROM are required when BASE_URL is https")
	}
	return c, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
