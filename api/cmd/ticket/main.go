package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ticket <serve|worker|migrate>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if args[0] == "serve" {
		if err := cfg.ValidateServe(); err != nil {
			return err
		}
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	switch args[0] {
	case "migrate":
		return db.Migrate(ctx, pool)
	case "serve":
		var githubUser *github.UserClient
		if cfg.GitHubAppClientID != "" || cfg.GitHubAppClientSecret != "" {
			githubUser, err = github.NewUserClient(github.UserClientConfig{
				ClientID: cfg.GitHubAppClientID, ClientSecret: cfg.GitHubAppClientSecret,
				AuthorizationURL: cfg.GitHubAuthorizationURL, TokenURL: cfg.GitHubTokenURL,
				APIURL: cfg.GitHubAPIURL, RedirectURL: strings.TrimRight(cfg.BaseURL, "/") + "/api/v1/auth/github/callback",
			})
			if err != nil {
				return err
			}
		}
		var mailer mail.Mailer = mail.NewLogMailer(slog.Default())
		if cfg.ResendAPIKey != "" && cfg.MailFrom != "" {
			mailer = mail.NewResend(cfg.ResendAPIKey, cfg.MailFrom, nil, "")
		}
		srv := &http.Server{
			Addr:              ":" + cfg.Port,
			Handler:           api.NewServer(pool, cfg, api.Dependencies{Mailer: mailer, GitHubUser: githubUser, CompleteGitHubInstallation: store.New(pool).BindInstallation}).Handler(),
			ReadHeaderTimeout: 10 * time.Second,
		}
		listener, err := net.Listen("tcp", srv.Addr)
		if err != nil {
			return err
		}
		slog.Info("listening", "addr", listener.Addr())
		return serve(ctx, srv, listener)
	case "worker":
		// The GitHub App is optional so a fresh install runs before it is
		// configured. Without it the worker still drains local jobs and simply
		// has nothing to sync, which beats crash-looping on day one.
		var client *github.Client
		if cfg.GitHubAppID != "" && cfg.GitHubAppPrivateKey != "" {
			var err error
			client, err = github.NewClient(cfg.GitHubAppID, []byte(cfg.GitHubAppPrivateKey), cfg.GitHubAPIURL)
			if err != nil {
				return err
			}
		} else {
			slog.Warn("GitHub App not configured; worker will not sync pull requests")
		}
		slog.Info("worker starting")
		return worker.New(store.New(pool), client).Run(ctx)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func serve(ctx context.Context, srv *http.Server, listener net.Listener) error {
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(listener)
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown server: %w", err)
		}
		if err := <-errCh; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
