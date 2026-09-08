package config

import (
	"fmt"
	"net/netip"
	"net/url"
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
	GitHubAppSlug     string
	TrustedProxyCIDRs []netip.Prefix
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
	for _, value := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(value)
		if err != nil || prefix.Bits() == 0 || prefix.Addr().Is4In6() {
			return nil, fmt.Errorf("TRUSTED_PROXY_CIDRS must contain explicit IPv4 or IPv6 CIDRs")
		}
		c.TrustedProxyCIDRs = append(c.TrustedProxyCIDRs, prefix.Masked())
	}
	return c, nil
}

// ValidateServe enforces settings needed only by the HTTP server. Workers and
// migrations never require mail secrets, even with a production BASE_URL.
func (c *Config) ValidateServe() error {
	base, err := url.Parse(c.BaseURL)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Path != "" && base.Path != "/") {
		return fmt.Errorf("BASE_URL must be an http or https origin")
	}
	if base.Scheme == "https" && (strings.TrimSpace(c.ResendAPIKey) == "" || strings.TrimSpace(c.MailFrom) == "") {
		return fmt.Errorf("RESEND_API_KEY and MAIL_FROM are required when BASE_URL is https")
	}
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
