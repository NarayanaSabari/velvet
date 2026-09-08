package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadRequiresOnlyDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://worklog:worklog@localhost/worklog")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "postgres://worklog:worklog@localhost/worklog", cfg.DatabaseURL)
}

func TestLoadAllowsHTTPSWithoutMailForNonServingCommands(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "https://velvet.example.com")
	t.Setenv("RESEND_API_KEY", "")
	t.Setenv("MAIL_FROM", "")
	_, err := Load()
	require.NoError(t, err)

	t.Setenv("RESEND_API_KEY", "re_test")
	t.Setenv("MAIL_FROM", "Velvet <noreply@mail.example.com>")
	t.Setenv("GITHUB_APP_SLUG", "velvet-worklog")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "re_test", cfg.ResendAPIKey)
	require.Equal(t, "velvet-worklog", cfg.GitHubAppSlug)
}

func TestLoadTrustedProxiesRejectsInvalidConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("TRUSTED_PROXY_CIDRS", "172.30.75.2/32,2001:db8::/64")
	cfg, err := Load()
	require.NoError(t, err)
	require.Len(t, cfg.TrustedProxyCIDRs, 2)
	require.Equal(t, "172.30.75.2/32", cfg.TrustedProxyCIDRs[0].String())
	for _, cidr := range []string{"typo", "0.0.0.0/0", "::/0"} {
		t.Setenv("TRUSTED_PROXY_CIDRS", cidr)
		_, err := Load()
		require.Error(t, err)
	}
}

func TestLoadAllowsNoMailLocally(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "http://localhost:8088")
	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.ResendAPIKey)
}

func TestLoadGitHubAppUserCredentialsAndEndpoints(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("GITHUB_CLIENT_ID", "old-oauth-client")
	t.Setenv("GITHUB_CLIENT_SECRET", "old-oauth-secret")
	t.Setenv("GITHUB_APP_CLIENT_ID", "app-client")
	t.Setenv("GITHUB_APP_CLIENT_SECRET", "app-secret")
	t.Setenv("GITHUB_AUTHORIZATION_URL", "http://localhost:18499/authorize")
	t.Setenv("GITHUB_TOKEN_URL", "http://host.docker.internal:18499/token")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "app-client", cfg.GitHubAppClientID)
	require.Equal(t, "app-secret", cfg.GitHubAppClientSecret)
	require.Equal(t, "http://localhost:18499/authorize", cfg.GitHubAuthorizationURL)
	require.Equal(t, "http://host.docker.internal:18499/token", cfg.GitHubTokenURL)
}
