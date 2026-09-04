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
		return fmt.Errorf("worker is implemented in plan 2")
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
