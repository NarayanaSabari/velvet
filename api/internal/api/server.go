package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/github"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type Server struct {
	pool                       *pgxpool.Pool
	cfg                        *config.Config
	store                      *store.Store
	broker                     *Broker
	mailer                     mail.Mailer
	githubUser                 *github.UserClient
	completeGitHubInstallation func(context.Context, store.GitHubAuthorization, github.VerifiedInstallation) error
}

type Dependencies struct {
	Mailer     mail.Mailer
	GitHubUser *github.UserClient
	// CompleteGitHubInstallation must bind, enqueue, and complete both states
	// in one transaction, using the store's workspace/admin and state locks.
	CompleteGitHubInstallation func(context.Context, store.GitHubAuthorization, github.VerifiedInstallation) error
}

func NewServer(pool *pgxpool.Pool, cfg *config.Config, deps Dependencies) *Server {
	return &Server{pool: pool, cfg: cfg, store: store.New(pool), broker: NewBroker(), mailer: deps.Mailer, githubUser: deps.GitHubUser, completeGitHubInstallation: deps.CompleteGitHubInstallation}
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

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	// Outside /api/v1 and unauthenticated by design: GitHub authenticates
	// itself with the HMAC signature, not a session.
	mux.HandleFunc("POST /webhooks/github", s.handleGitHubWebhook)

	s.registerAuthRoutes(mux)
	s.registerAPITokenRoutes(mux)
	s.registerOrganisationRoutes(mux)
	s.registerInviteRoutes(mux)
	s.registerMembershipRoutes(mux)
	s.registerSprintRoutes(mux)
	s.registerMilestoneRoutes(mux)
	s.registerProjectRoutes(mux)
	s.registerIssueRoutes(mux)
	s.registerLabelRoutes(mux)
	s.registerCommentRoutes(mux)
	s.registerActivityRoutes(mux)
	s.registerGitHubRoutes(mux)
	s.registerGitHubAuthorizationRoutes(mux)
	s.registerReportRoutes(mux)

	return RequestID(Logging(Recover(s.browserMutations(mux))))
}
