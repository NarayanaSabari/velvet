package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/worker"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ticket <serve|worker|migrate>")
	}
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		return err
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
		srv := &http.Server{
			Addr:              ":" + cfg.Port,
			Handler:           api.NewServer(pool, cfg).Handler(),
			ReadHeaderTimeout: 10 * time.Second,
		}
		slog.Info("listening", "addr", srv.Addr)
		return srv.ListenAndServe()
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
