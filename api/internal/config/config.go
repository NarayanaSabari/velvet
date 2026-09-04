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
	BaseURL            string
}

func Load() (*Config, error) {
	c := &Config{
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		Port:               envOr("PORT", "8080"),
		SessionSecret:      os.Getenv("SESSION_SECRET"),
		GitHubClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		BaseURL:            envOr("BASE_URL", "http://localhost:8080"),
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
