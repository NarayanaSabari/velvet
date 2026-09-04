package api

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type Server struct {
	pool  *pgxpool.Pool
	cfg   *config.Config
	store *store.Store
}

func NewServer(pool *pgxpool.Pool, cfg *config.Config) *Server {
	return &Server{pool: pool, cfg: cfg, store: store.New(pool)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if err := s.pool.Ping(r.Context()); err != nil {
			WriteError(w, http.StatusServiceUnavailable, "unavailable", "database unreachable")
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Exercised only by TestPanicBecomesInternalError; harmless in production
	// and worth keeping so the recovery path stays covered.
	mux.HandleFunc("GET /api/v1/panic-test", func(http.ResponseWriter, *http.Request) {
		panic("deliberate panic")
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	s.registerAuthRoutes(mux)
	s.registerSprintRoutes(mux)
	s.registerMilestoneRoutes(mux)
	s.registerIssueRoutes(mux)
	s.registerLabelRoutes(mux)
	s.registerCommentRoutes(mux)

	return RequestID(Logging(Recover(mux)))
}
