package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// The hosted MCP endpoint lets a coding agent use Velvet with nothing installed
// on the developer's machine. An agent is configured with one URL, which names
// the organisation, and one personal API token:
//
//	https://velvet.example.com/api/v1/w/{slug}/mcp
//	Authorization: Bearer velvet_...
//
// Every tool call is dispatched through this server's own REST handlers rather
// than reimplementing data access, so the endpoint inherits the same
// membership checks, role rules, validation, and "written by an agent" source
// attribution as the REST API. A tool can never do more than the token could
// already do with curl.
const mcpMaxBodyBytes = 1 << 20

var mcpIssueKey = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])([a-z]{2,6}-\d+)(?:$|[^a-z0-9])`)

var mcpIssueStatuses = []string{"backlog", "todo", "in_progress", "in_review", "done", "cancelled"}

var mcpNoteKinds = []string{"progress", "decision", "blocker", "note"}

type mcpRequestKey struct{}

// registerMCPRoutes mounts the endpoint. The api handler is the REST handler
// behind the browser guard, so in-process calls get the same checks as an
// external request, and it does not contain this route, so a tool cannot call
// MCP recursively.
func (s *Server) registerMCPRoutes(mux *http.ServeMux, api http.Handler) {
	// The tool set never changes, so one server instance serves every request.
	// Stateless mode keeps no per-caller session in memory: each POST carries
	// its own bearer token, and the organisation is in the URL.
	server := mcp.NewServer(&mcp.Implementation{Name: "velvet", Title: "Velvet", Version: "1.0.0"}, &mcp.ServerOptions{
		Instructions: "Velvet is the person's work log. After each meaningful unit of work, record a short " +
			"factual entry with velvet_log_work. Never change a ticket status unless the person explicitly " +
			"asks, and never invent time spent.",
	})
	registerMCPTools(server, s.cfg.BaseURL, api)

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless:           true,
		JSONResponse:        true,
		MaxRequestBodyBytes: mcpMaxBodyBytes,
	})

	// Only API tokens may use MCP. A browser cookie must never be able to drive
	// agent tools, so a cookie-authenticated call is refused before dispatch,
	// which is also what makes this route safe outside the browser guard.
	guarded := s.RequireWorkspace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isBearerAuth(r.Context()) {
			WriteError(w, http.StatusForbidden, "forbidden", "an API token is required for MCP")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mcpRequestKey{}, r)))
	}))
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
		mux.Handle(method+" /api/v1/w/{slug}/mcp", guarded)
	}
}

// mcpCall is what one tool invocation needs: the caller's credential and
// organisation, and the in-process API to call with them.
type mcpCall struct {
	api           http.Handler
	baseURL       string
	authorization string
	membership    store.Membership
}

func newMCPCall(ctx context.Context, baseURL string, api http.Handler) (*mcpCall, error) {
	origin, ok := ctx.Value(mcpRequestKey{}).(*http.Request)
	membership, member := CurrentWorkspace(ctx)
	if !ok || origin == nil || !member {
		return nil, errors.New("this tool must be called over the hosted MCP endpoint")
	}
	return &mcpCall{
		api:           api,
		baseURL:       strings.TrimRight(baseURL, "/"),
		authorization: origin.Header.Get("Authorization"),
		membership:    membership,
	}, nil
}

func (c *mcpCall) slug() string {
	return c.membership.Slug
}

// scoped is the REST prefix for the organisation named in the MCP URL.
func (c *mcpCall) scoped() string {
	return "/api/v1/w/" + url.PathEscape(c.slug())
}

func (c *mcpCall) issueURL(key string) string {
	return c.baseURL + "/w/" + url.PathEscape(c.slug()) + "/issues/" + url.PathEscape(key)
}

// do sends one in-process request with the caller's own bearer token, so the
// API applies exactly the permissions that token already has.
func (c *mcpCall) do(ctx context.Context, method, path string, body any, out any) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	req := httptest.NewRequest(method, path, &buf).WithContext(ctx)
	req.Header.Set("Authorization", c.authorization)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	c.api.ServeHTTP(rec, req)

	if rec.Code >= 300 {
		var failure ErrorResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &failure)
		switch {
		case rec.Code == http.StatusUnauthorized:
			return errors.New("token invalid or revoked")
		case failure.Error.Message != "":
			return errors.New(failure.Error.Message)
		default:
			return fmt.Errorf("Velvet returned HTTP %d", rec.Code)
		}
	}
	if out == nil || rec.Body.Len() == 0 {
		return nil
	}
	return json.Unmarshal(rec.Body.Bytes(), out)
}

func mcpText(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// mcpLine flattens a value to one line so tool output stays compact.
func mcpLine(value string, fallback string) string {
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return fallback
	}
	return value
}

func mcpKey(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func oneOf(value string, allowed []string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func sortedCounts(counts map[string]int) string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s: %d", key, counts[key]))
	}
	return strings.Join(parts, ", ")
}
