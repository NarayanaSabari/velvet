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

func TestLoadRequiresMailInProduction(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "https://velvet.example.com")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "RESEND_API_KEY")

	t.Setenv("RESEND_API_KEY", "re_test")
	t.Setenv("MAIL_FROM", "Velvet <noreply@mail.example.com>")
	t.Setenv("GITHUB_APP_SLUG", "velvet-worklog")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "re_test", cfg.ResendAPIKey)
	require.Equal(t, "velvet-worklog", cfg.GitHubAppSlug)
}

func TestLoadAllowsNoMailLocally(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("BASE_URL", "http://localhost:8088")
	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.ResendAPIKey)
}
