package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerGitHubRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	admin := RequireRole("admin")

	mux.Handle("GET /api/v1/w/{slug}/issues/{key}/evidence",
		s.RequireWorkspace(http.HandlerFunc(s.handleIssueEvidence)))
	mux.Handle("POST /api/v1/w/{slug}/issues/{key}/prs",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleAttachPR))))
	mux.Handle("DELETE /api/v1/w/{slug}/issues/{key}/prs/{prID}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleDetachPR))))
	mux.Handle("GET /api/v1/w/{slug}/pull-requests/unlinked",
		s.RequireWorkspace(http.HandlerFunc(s.handleUnlinkedPRs)))
	mux.Handle("GET /api/v1/w/{slug}/repos",
		s.RequireWorkspace(http.HandlerFunc(s.handleListRepos)))
	mux.Handle("POST /api/v1/w/{slug}/repos",
		s.RequireWorkspace(admin(http.HandlerFunc(s.handleLinkRepo))))
}

func (s *Server) handleIssueEvidence(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, r.PathValue("key"))
	if err != nil {
		writeIssueError(w, err)
		return
	}
	evidence, err := s.store.EvidenceForIssue(r.Context(), ws.WorkspaceID, issue.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not read the evidence")
		return
	}
	WriteJSON(w, http.StatusOK, evidence)
}

// handleAttachPR records a PR as evidence on an issue. It deliberately does
// not touch the issue's status: attaching proof of work is not the same as
// deciding the work is finished.
//
// Attaching an already-attached PR answers 201 without a second activity row,
// so a double click reads as one attachment rather than two.
func (s *Server) handleAttachPR(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PullRequestID string `json:"pull_request_id"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	prID, err := uuid.Parse(body.PullRequestID)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "pull_request_id must be a UUID")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, r.PathValue("key"))
	if err != nil {
		writeIssueError(w, err)
		return
	}

	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	if err := s.store.ManualLink(r.Context(), ws.WorkspaceID, issue.ID, prID, user.ID); err != nil {
		writePRError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusCreated, map[string]any{"attached": true})
}

func (s *Server) handleDetachPR(w http.ResponseWriter, r *http.Request) {
	prID, err := uuid.Parse(r.PathValue("prID"))
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "pull request id must be a UUID")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	issue, err := s.store.GetIssueByKey(r.Context(), ws.WorkspaceID, r.PathValue("key"))
	if err != nil {
		writeIssueError(w, err)
		return
	}
	if err := s.store.Unlink(r.Context(), ws.WorkspaceID, issue.ID, prID); err != nil {
		writePRError(w, err)
		return
	}
	WriteJSON(w, http.StatusNoContent, nil)
}

func (s *Server) handleUnlinkedPRs(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())

	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			WriteError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	prs, err := s.store.UnlinkedPullRequests(r.Context(), ws.WorkspaceID, limit)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list pull requests")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"pull_requests": prs})
}

func (s *Server) handleListRepos(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	repos, err := s.store.ListRepos(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list repositories")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"repos": repos})
}

func (s *Server) handleLinkRepo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GitHubID       int64  `json:"github_id"`
		Owner          string `json:"owner"`
		Name           string `json:"name"`
		InstallationID int64  `json:"installation_id"`
		DefaultBranch  string `json:"default_branch"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.GitHubID == 0 || body.Owner == "" || body.Name == "" || body.InstallationID == 0 {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"github_id, owner, name, and installation_id are required")
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	repo, err := s.store.LinkRepo(r.Context(), store.LinkRepoInput{
		WorkspaceID: ws.WorkspaceID, InstallationID: body.InstallationID,
		GitHubID: body.GitHubID, Owner: body.Owner, Name: body.Name,
		DefaultBranch: body.DefaultBranch})
	if err != nil {
		writePRError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, repo)
}

// writePRError answers 400 for a reference to another workspace's pull
// request, because that is a client mistake rather than a server failure, and
// a 404 would leak whether the id exists at all.
func writePRError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrForeignReference) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"that pull request belongs to another workspace")
		return
	}
	writeStoreError(w, err, "pull request")
}
