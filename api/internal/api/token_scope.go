package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// A key minted by `velvet init` is bound to one organisation and one project.
// Holding it to that scope is the server's job, not the CLI's: velvet.yaml is
// an ordinary file an agent can edit, so nothing it says can widen access.
//
// The rule is default-deny. A scoped key reaches only the routes listed in
// scopedRoutes, and each of those checks that the issue, milestone, sprint, or
// image it touches belongs to the key's project. Every other route answers 403
// before its handler runs, so a new route is closed to agents until someone
// decides it should be open.

const scopeKey ctxKey = "token_scope"

func tokenScope(r *http.Request) store.TokenScope {
	scope, _ := r.Context().Value(scopeKey).(store.TokenScope)
	return scope
}

// scopedRoutes is every route a project-scoped key may call, keyed by the
// exact pattern the mux matched.
var scopedRoutes = map[string]bool{
	"GET /api/v1/me":                                      true,
	"DELETE /api/v1/me/token":                             true,
	"GET /api/v1/me/worklog":                              true,
	"GET /api/v1/me/worklog.md":                           true,
	"GET /api/v1/w/{slug}/projects/{key}":                 true,
	"GET /api/v1/w/{slug}/projects/{key}/comments":        true,
	"POST /api/v1/w/{slug}/projects/{key}/comments":       true,
	"GET /api/v1/w/{slug}/issues":                         true,
	"POST /api/v1/w/{slug}/issues":                        true,
	"GET /api/v1/w/{slug}/issues/{key}":                   true,
	"PATCH /api/v1/w/{slug}/issues/{key}":                 true,
	"GET /api/v1/w/{slug}/issues/{key}/comments":          true,
	"POST /api/v1/w/{slug}/issues/{key}/comments":         true,
	"GET /api/v1/w/{slug}/issues/{key}/evidence":          true,
	"POST /api/v1/w/{slug}/issues/{key}/evidence":         true,
	"GET /api/v1/w/{slug}/issues/{key}/images":            true,
	"POST /api/v1/w/{slug}/issues/{key}/images":           true,
	"GET /api/v1/w/{slug}/sprints":                        true,
	"POST /api/v1/w/{slug}/sprints":                       true,
	"GET /api/v1/w/{slug}/sprints/{id}":                   true,
	"GET /api/v1/w/{slug}/sprints/{sprintID}/milestones":  true,
	"POST /api/v1/w/{slug}/sprints/{sprintID}/milestones": true,
	"GET /api/v1/w/{slug}/milestones":                     true,
	"GET /api/v1/w/{slug}/milestones/{id}":                true,
	"GET /api/v1/w/{slug}/milestones/{id}/images":         true,
	"POST /api/v1/w/{slug}/milestones/{id}/images":        true,
	"GET /api/v1/w/{slug}/images/{id}/content":            true,
}

// Setup credentials cannot read work data or manage arbitrary credentials.
var setupRoutes = map[string]bool{
	"GET /api/v1/me":                  true,
	"POST /api/v1/orgs":               true,
	"GET /api/v1/w/{slug}/projects":   true,
	"POST /api/v1/w/{slug}/projects":  true,
	"DELETE /api/v1/me/token":         true,
	"POST /api/v1/cli/project-tokens": true,
}

func forbidScope(w http.ResponseWriter, msg string) {
	WriteError(w, http.StatusForbidden, "out_of_scope", msg)
}

// enforceTokenScope runs once per request, after the mux has picked a route
// and before the handler. It returns false when it has already answered.
func (s *Server) enforceTokenScope(w http.ResponseWriter, r *http.Request) bool {
	scope := tokenScope(r)
	if scope.Kind == "setup" {
		if !setupRoutes[r.Pattern] {
			forbidScope(w, "this setup key can only configure organisations and project credentials")
			return false
		}
		return true
	}
	if !scope.Scoped() {
		return true
	}
	if !scopedRoutes[r.Pattern] {
		forbidScope(w, "this key is limited to one project and cannot use this endpoint")
		return false
	}
	ws, inWorkspace := CurrentWorkspace(r.Context())
	if !inWorkspace {
		// Routes outside an organisation (/me...) are narrowed by their
		// handlers via tokenScope.
		return true
	}
	if ws.WorkspaceID != *scope.WorkspaceID {
		// Indistinguishable from an organisation the person is not in.
		WriteError(w, http.StatusNotFound, "not_found", "no such workspace")
		return false
	}

	ctx := r.Context()
	project := *scope.ProjectID
	switch {
	case r.PathValue("key") != "" && strings.Contains(r.Pattern, "/projects/{key}"):
		id, err := s.store.ProjectIDByKey(ctx, ws.WorkspaceID, store.NormalizeProjectKey(r.PathValue("key")))
		if err != nil || id != project {
			forbidScope(w, "this key can only reach its own project")
			return false
		}
	case r.PathValue("key") != "":
		issue, err := s.store.GetIssueByKey(ctx, ws.WorkspaceID, pathIssueKey(r))
		if err != nil {
			writeIssueError(w, err)
			return false
		}
		if issue.ProjectID == nil || *issue.ProjectID != project {
			forbidScope(w, "this ticket is outside the project this key is limited to")
			return false
		}
	case strings.Contains(r.Pattern, "/milestones/{id}"):
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil || !s.milestoneInProject(r, ws.WorkspaceID, id, project) {
			forbidScope(w, "this milestone is outside the project this key is limited to")
			return false
		}
	case strings.Contains(r.Pattern, "/sprints/{id}") || strings.Contains(r.Pattern, "/sprints/{sprintID}"):
		raw := r.PathValue("id")
		if raw == "" {
			raw = r.PathValue("sprintID")
		}
		id, err := uuid.Parse(raw)
		if err != nil {
			forbidScope(w, "this sprint is outside the project this key is limited to")
			return false
		}
		sprint, err := s.store.GetSprint(ctx, ws.WorkspaceID, id)
		if err != nil || sprint.ProjectID != project {
			forbidScope(w, "this sprint is outside the project this key is limited to")
			return false
		}
	case strings.Contains(r.Pattern, "/images/{id}"):
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil || !s.imageInProject(r, ws.WorkspaceID, id, project) {
			forbidScope(w, "this image is outside the project this key is limited to")
			return false
		}
	}
	return true
}

func (s *Server) milestoneInProject(r *http.Request, workspaceID, milestoneID, projectID uuid.UUID) bool {
	owner, err := s.store.MilestoneProjectID(r.Context(), workspaceID, milestoneID)
	return err == nil && owner == projectID
}

func (s *Server) imageInProject(r *http.Request, workspaceID, imageID, projectID uuid.UUID) bool {
	owner, err := s.store.ImageProjectID(r.Context(), workspaceID, imageID)
	return err == nil && owner == projectID
}

func (s *Server) issueIDInProject(r *http.Request, workspaceID, issueID, projectID uuid.UUID) bool {
	owner, err := s.store.IssueProjectID(r.Context(), workspaceID, issueID)
	return err == nil && owner != nil && *owner == projectID
}

// scopedProject returns the project a scoped key is bound to, so list and
// create handlers can pin themselves to it.
func scopedProject(r *http.Request) (uuid.UUID, bool) {
	scope := tokenScope(r)
	if !scope.Scoped() {
		return uuid.Nil, false
	}
	return *scope.ProjectID, true
}
