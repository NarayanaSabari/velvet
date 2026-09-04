package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (s *Server) registerSprintRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/sprints",
		s.RequireWorkspace(http.HandlerFunc(s.handleListSprints)))
	mux.Handle("POST /api/v1/w/{slug}/sprints",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateSprint))))
	mux.Handle("GET /api/v1/w/{slug}/sprints/{id}",
		s.RequireWorkspace(http.HandlerFunc(s.handleGetSprint)))
	mux.Handle("POST /api/v1/w/{slug}/sprints/{id}/activate",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleActivateSprint))))
	mux.Handle("POST /api/v1/w/{slug}/sprints/{id}/close",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCloseSprint))))
}

func (s *Server) handleListSprints(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	sprints, err := s.store.ListSprints(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list sprints")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"sprints": sprints})
}

func (s *Server) handleCreateSprint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		StartsOn string `json:"starts_on"`
		EndsOn   string `json:"ends_on"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Name == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	if !dateRe.MatchString(body.StartsOn) || !dateRe.MatchString(body.EndsOn) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "dates must be YYYY-MM-DD")
		return
	}
	if body.EndsOn < body.StartsOn {
		WriteError(w, http.StatusBadRequest, "invalid_request", "ends_on must not precede starts_on")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sprint, err := s.store.CreateSprint(r.Context(), store.CreateSprintInput{
		WorkspaceID: ws.WorkspaceID, ActorID: user.ID,
		Name: body.Name, StartsOn: body.StartsOn, EndsOn: body.EndsOn,
	})
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not create the sprint")
		return
	}
	WriteJSON(w, http.StatusCreated, sprint)
}

func (s *Server) handleGetSprint(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	sprint, err := s.store.GetSprint(r.Context(), ws.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, err, "sprint")
		return
	}
	WriteJSON(w, http.StatusOK, sprint)
}

func (s *Server) handleActivateSprint(w http.ResponseWriter, r *http.Request) {
	s.mutateSprint(w, r, s.store.ActivateSprint)
}

func (s *Server) handleCloseSprint(w http.ResponseWriter, r *http.Request) {
	s.mutateSprint(w, r, s.store.CloseSprint)
}

type sprintMutator func(ctx context.Context, workspaceID, id, actorID uuid.UUID) (store.Sprint, error)

func (s *Server) mutateSprint(w http.ResponseWriter, r *http.Request, fn sprintMutator) {
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	sprint, err := fn(r.Context(), ws.WorkspaceID, id, user.ID)
	if err != nil {
		writeStoreError(w, err, "sprint")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, sprint)
}

// pathUUID parses a {name} path value, answering 400 rather than 500 on junk.
func pathUUID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", name+" must be a UUID")
		return uuid.Nil, false
	}
	return id, true
}

func writeStoreError(w http.ResponseWriter, err error, what string) {
	if errors.Is(err, store.ErrNotFound) {
		WriteError(w, http.StatusNotFound, "not_found", "no such "+what)
		return
	}
	WriteError(w, http.StatusInternalServerError, "internal", "could not read the "+what)
}
