package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestServeStopsCleanlyWhenCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, srv, listener) }()

	require.Eventually(t, func() bool {
		client := &http.Client{Timeout: 100 * time.Millisecond}
		res, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			return false
		}
		res.Body.Close()
		return res.StatusCode == http.StatusNoContent
	}, time.Second, 10*time.Millisecond)
	cancel()

	require.NoError(t, <-done)
}

func TestHTTPSMigrateAndWorkerDoNotRequireMail(t *testing.T) {
	pool := testutil.NewPostgres(t)
	t.Setenv("DATABASE_URL", pool.Config().ConnString())
	t.Setenv("BASE_URL", "https://velvet.example.com")
	t.Setenv("RESEND_API_KEY", "")
	t.Setenv("MAIL_FROM", "")
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
	require.NoError(t, run(t.Context(), []string{"migrate"}))
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	require.NoError(t, run(ctx, []string{"worker"}))
}

func TestHTTPSServeRequiresMailBeforeOpeningDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://unreachable.invalid/db")
	t.Setenv("BASE_URL", "https://velvet.example.com")
	t.Setenv("RESEND_API_KEY", "")
	t.Setenv("MAIL_FROM", "")
	err := run(t.Context(), []string{"serve"})
	require.ErrorContains(t, err, "RESEND_API_KEY")
}
