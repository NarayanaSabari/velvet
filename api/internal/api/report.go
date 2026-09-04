package api

import (
	"net/http"
	"strconv"
)

const (
	defaultStaleDays = 14
	maxStaleDays     = 365
)

func (s *Server) registerReportRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/w/{slug}/reports/activity",
		s.RequireWorkspace(http.HandlerFunc(s.handleReportActivity)))
	mux.Handle("GET /api/v1/w/{slug}/reports/milestones",
		s.RequireWorkspace(http.HandlerFunc(s.handleReportMilestones)))
	mux.Handle("GET /api/v1/w/{slug}/reports/closed",
		s.RequireWorkspace(http.HandlerFunc(s.handleReportClosed)))
	mux.Handle("GET /api/v1/w/{slug}/reports/stale",
		s.RequireWorkspace(http.HandlerFunc(s.handleReportStale)))
}

func (s *Server) handleReportActivity(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	query := r.URL.Query()
	from, to := query.Get("from"), query.Get("to")
	if (from != "" && !dateRe.MatchString(from)) || (to != "" && !dateRe.MatchString(to)) {
		WriteError(w, http.StatusBadRequest, "invalid_request", "dates must be YYYY-MM-DD")
		return
	}

	people, err := s.store.PersonActivity(r.Context(), ws.WorkspaceID, from, to)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the activity report")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"people": people})
}

func (s *Server) handleReportMilestones(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	sprints, err := s.store.MilestoneCompletion(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the milestone report")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"sprints": sprints})
}

func (s *Server) handleReportClosed(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())
	sprints, err := s.store.IssuesClosedPerSprint(r.Context(), ws.WorkspaceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the closed report")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"sprints": sprints})
}

func (s *Server) handleReportStale(w http.ResponseWriter, r *http.Request) {
	ws, _ := CurrentWorkspace(r.Context())

	days := defaultStaleDays
	if raw := r.URL.Query().Get("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxStaleDays {
			WriteError(w, http.StatusBadRequest, "invalid_request",
				"days must be between 1 and "+strconv.Itoa(maxStaleDays))
			return
		}
		days = parsed
	}

	issues, err := s.store.StaleIssues(r.Context(), ws.WorkspaceID, days)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the stale report")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"issues": issues, "days": days})
}
