package api

import (
	"net/http"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerMilestoneRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	mux.Handle("GET /api/v1/w/{slug}/sprints/{sprintID}/milestones",
		s.RequireWorkspace(http.HandlerFunc(s.handleListMilestones)))
	mux.Handle("POST /api/v1/w/{slug}/sprints/{sprintID}/milestones",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateMilestone))))
	mux.Handle("GET /api/v1/w/{slug}/milestones/{id}",
		s.RequireWorkspace(http.HandlerFunc(s.handleGetMilestone)))
	mux.Handle("PATCH /api/v1/w/{slug}/milestones/{id}",
		s.RequireWorkspace(writer(http.HandlerFunc(s.handleUpdateMilestone))))
}

func (s *Server) handleListMilestones(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	sprintID, ok := pathUUID(w, r, "sprintID")
	if !ok {
		return
	}
	milestones, err := s.store.ListMilestonesForSprint(r.Context(), ws.WorkspaceID, sprintID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not list milestones")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"milestones": milestones})
}

func (s *Server) handleCreateMilestone(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		OwnerID     *string `json:"owner_id"`
		TargetDate  *string `json:"target_date"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Name == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	if body.TargetDate != nil && !dateRe.MatchString(*body.TargetDate) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "target_date must be YYYY-MM-DD")
		return
	}
	ownerID, ok := parseOptionalUUID(w, body.OwnerID, "owner_id")
	if !ok {
		return
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	sprintID, ok := pathUUID(w, r, "sprintID")
	if !ok {
		return
	}

	milestone, err := s.store.CreateMilestone(r.Context(), store.CreateMilestoneInput{
		WorkspaceID: ws.WorkspaceID, SprintID: sprintID, ActorID: user.ID,
		Name: body.Name, Description: body.Description,
		OwnerID: ownerID, TargetDate: body.TargetDate,
	})
	if err != nil {
		writeStoreError(w, err, "sprint")
		return
	}
	WriteJSON(w, http.StatusCreated, milestone)
}

func (s *Server) handleGetMilestone(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	milestone, err := s.store.GetMilestone(r.Context(), ws.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, err, "milestone")
		return
	}
	WriteJSON(w, http.StatusOK, milestone)
}

func (s *Server) handleUpdateMilestone(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		TargetDate  *string `json:"target_date"`
		OwnerID     *string `json:"owner_id"`
		AfterID     *string `json:"after_id"`
		BeforeID    *string `json:"before_id"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	if body.Status != nil && !store.ValidMilestoneStatus(*body.Status) {
		WriteError(w, http.StatusBadRequest, "invalid_request",
			"status must be one of planned, in_progress, completed, cancelled")
		return
	}
	if body.TargetDate != nil && !dateRe.MatchString(*body.TargetDate) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "target_date must be YYYY-MM-DD")
		return
	}

	patch := store.MilestonePatch{
		Name: body.Name, Description: body.Description,
		Status: body.Status, TargetDate: body.TargetDate,
	}
	// An explicit owner_id of null clears the owner, while omitting the field
	// leaves it alone, which is why the patch field is a double pointer.
	if body.OwnerID != nil {
		ownerID, ok := parseOptionalUUID(w, body.OwnerID, "owner_id")
		if !ok {
			return
		}
		patch.OwnerID = &ownerID
	}
	for _, f := range []struct {
		raw *string
		dst **uuid.UUID
		key string
	}{{body.AfterID, &patch.AfterID, "after_id"}, {body.BeforeID, &patch.BeforeID, "before_id"}} {
		id, ok := parseOptionalUUID(w, f.raw, f.key)
		if !ok {
			return
		}
		*f.dst = id
	}

	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	sinceID, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	milestone, err := s.store.UpdateMilestone(r.Context(), ws.WorkspaceID, id, user.ID, patch)
	if err != nil {
		writeStoreError(w, err, "milestone")
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, sinceID)
	WriteJSON(w, http.StatusOK, milestone)
}

// parseOptionalUUID turns an absent or null field into a nil pointer, and junk
// into a 400 rather than a 500.
func parseOptionalUUID(w http.ResponseWriter, raw *string, name string) (*uuid.UUID, bool) {
	if raw == nil || *raw == "" {
		return nil, true
	}
	id, err := uuid.Parse(*raw)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", name+" must be a UUID")
		return nil, false
	}
	return &id, true
}
