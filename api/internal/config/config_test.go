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
