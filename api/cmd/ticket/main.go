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
		if cfg.GitHubAppID == "" || cfg.GitHubAppPrivateKey == "" {
			return fmt.Errorf("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to run the worker")
		}
		client, err := github.NewClient(cfg.GitHubAppID, []byte(cfg.GitHubAppPrivateKey), "")
		if err != nil {
			return err
		}
		slog.Info("worker starting")
		return worker.New(store.New(pool), client).Run(ctx)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
