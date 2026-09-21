package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

func (s *Server) registerWorklogRoutes(mux *http.ServeMux) {
	// Deliberately outside /w/{slug}: the question this answers spans every
	// organisation the caller belongs to.
	mux.Handle("GET /api/v1/me/worklog", s.RequireAuth(http.HandlerFunc(s.handleWorklog)))
	mux.Handle("GET /api/v1/me/worklog.md", s.RequireAuth(http.HandlerFunc(s.handleWorklogMarkdown)))
}

func (s *Server) worklogEntries(w http.ResponseWriter, r *http.Request) ([]store.WorklogEntry, bool) {
	query := r.URL.Query()
	filter := store.WorklogFilter{
		From:      query.Get("from"),
		To:        query.Get("to"),
		Workspace: query.Get("workspace"),
		Project:   query.Get("project"),
	}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 {
			WriteError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return nil, false
		}
		filter.Limit = limit
	}
	// A window of days is the form the question actually takes: "what did I do
	// in the last week" rather than "between these two dates".
	if raw := query.Get("days"); raw != "" {
		days, err := strconv.Atoi(raw)
		if err != nil || days < 1 {
			WriteError(w, http.StatusBadRequest, "invalid_request", "days must be a positive integer")
			return nil, false
		}
		filter.From, filter.To = store.WindowForDays(days)
	}

	user, _ := CurrentUser(r.Context())
	entries, err := s.store.Worklog(r.Context(), user.ID, filter)
	if err != nil {
		if errors.Is(err, store.ErrInvalidCursor) {
			WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return nil, false
		}
		WriteError(w, http.StatusInternalServerError, "internal", "could not build the work log")
		return nil, false
	}
	return entries, true
}

func (s *Server) handleWorklog(w http.ResponseWriter, r *http.Request) {
	entries, ok := s.worklogEntries(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// handleWorklogMarkdown returns the same record as prose, so the answer to
// "what were you working on last week" can be pasted into a message without
// anyone opening the UI.
func (s *Server) handleWorklogMarkdown(w http.ResponseWriter, r *http.Request) {
	entries, ok := s.worklogEntries(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, RenderWorklogMarkdown(entries))
}

// RenderWorklogMarkdown groups by day, then by organisation, which is how a
// person reconstructs their own week.
func RenderWorklogMarkdown(entries []store.WorklogEntry) string {
	if len(entries) == 0 {
		return "# Work log\n\nNo recorded work in this period.\n"
	}

	var b strings.Builder
	b.WriteString("# Work log\n")
	day, workspace := "", ""
	for _, e := range entries {
		if e.Day != day {
			day, workspace = e.Day, ""
			fmt.Fprintf(&b, "\n## %s\n", e.Day)
		}
		if e.WorkspaceSlug != workspace {
			workspace = e.WorkspaceSlug
			fmt.Fprintf(&b, "\n### %s\n\n", e.WorkspaceName)
		}
		b.WriteString("- " + worklogLine(e) + "\n")
	}
	return b.String()
}

func worklogLine(e store.WorklogEntry) string {
	var parts []string
	if e.ProjectKey != nil {
		parts = append(parts, "["+*e.ProjectKey+"]")
	}
	if e.IssueKey != nil {
		parts = append(parts, *e.IssueKey)
	}

	switch e.Kind {
	case "note":
		// The note body is the actual record of what happened, so it is the
		// text shown rather than the title of whatever it hung off.
		parts = append(parts, firstLine(e.Body))
	case "issue":
		parts = append(parts, e.Title)
		if e.Status != "" {
			parts = append(parts, "("+e.Status+")")
		}
	case "pull_request":
		parts = append(parts, "PR: "+e.Title)
		if e.URL != "" {
			parts = append(parts, e.URL)
		}
	case "commit":
		parts = append(parts, "commit: "+firstLine(e.Title))
	}
	return strings.Join(parts, " ")
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}
