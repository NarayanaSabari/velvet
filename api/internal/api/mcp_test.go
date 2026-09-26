package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// bearerTransport adds the agent's token to every request, the way Claude Code
// and Codex send the Authorization header they were configured with.
type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (t bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(r)
}

// connectMCP connects a real MCP client over HTTP to the real API handler.
func connectMCP(t *testing.T, f *testutil.Fixture, slug, token string) *mcp.ClientSession {
	t.Helper()
	server := httptest.NewServer(f.Handler)
	t.Cleanup(server.Close)
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{
		Endpoint:             server.URL + "/api/v1/w/" + slug + "/mcp",
		HTTPClient:           &http.Client{Transport: bearerTransport{token: token, base: http.DefaultTransport}},
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callTool(t *testing.T, session *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	require.NoError(t, err)
	var text strings.Builder
	for _, content := range result.Content {
		if c, ok := content.(*mcp.TextContent); ok {
			text.WriteString(c.Text)
		}
	}
	return text.String(), result.IsError
}

// The whole point of the hosted endpoint: an agent configured with only a URL
// and a token can find the tools and write to the person's work log.
func TestAnAgentCanLogWorkThroughHostedMCP(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Wire up hosted MCP")
	token := f.AgentToken("claude code")
	session := connectMCP(t, f, f.Slug, token)

	tools, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	for _, want := range []string{
		"velvet_where_am_i", "velvet_log_work", "velvet_current_ticket", "velvet_get_ticket",
		"velvet_create_ticket", "velvet_list_issues", "velvet_update_ticket", "velvet_set_status",
		"velvet_attach_evidence", "velvet_my_worklog", "velvet_list_projects", "velvet_list_sprints",
		"velvet_create_sprint", "velvet_create_milestone", "velvet_list_milestones",
	} {
		require.True(t, names[want], "missing tool %s", want)
	}

	text, isErr := callTool(t, session, "velvet_where_am_i", nil)
	require.False(t, isErr, text)
	require.Contains(t, text, "Organisation: Lab (lab)")
	require.Contains(t, text, "Role: admin")

	text, isErr = callTool(t, session, "velvet_log_work", map[string]any{
		"key": strings.ToLower(issue.Key), "body": "Wired the hosted endpoint to the REST handlers.", "kind": "progress",
	})
	require.False(t, isErr, text)
	require.Contains(t, text, "Logged work to "+issue.Key)

	// The entry is recorded as the agent's, attributed to the token that wrote it.
	var source, tokenName string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `
		SELECT c.source, t.name FROM comment c JOIN api_token t ON t.id = c.api_token_id
		WHERE c.target_id = $1`, issue.ID).Scan(&source, &tokenName))
	require.Equal(t, "agent", source)
	require.Equal(t, "claude code", tokenName)

	text, isErr = callTool(t, session, "velvet_current_ticket", map[string]any{"branch": "sabari/" + strings.ToLower(issue.Key) + "-hosted-mcp"})
	require.False(t, isErr, text)
	require.Contains(t, text, issue.Key+": Wire up hosted MCP")
	require.Contains(t, text, "Wired the hosted endpoint to the REST handlers.")
}

func TestHostedMCPCreatesAndListsTickets(t *testing.T) {
	f := testutil.NewFixture(t)
	session := connectMCP(t, f, f.Slug, f.AgentToken("codex"))

	text, isErr := callTool(t, session, "velvet_create_ticket", map[string]any{"title": "Document the MCP URL", "priority": 2})
	require.False(t, isErr, text)
	require.Contains(t, text, "Created ENG-")
	require.Contains(t, text, "URL: http://localhost:8080/w/lab/issues/ENG-")

	text, isErr = callTool(t, session, "velvet_list_issues", nil)
	require.False(t, isErr, text)
	require.Contains(t, text, "Document the MCP URL")

	// Status only changes on request, and the tool validates it before calling.
	text, isErr = callTool(t, session, "velvet_set_status", map[string]any{"key": "ENG-1", "status": "finished"})
	require.True(t, isErr)
	require.Contains(t, text, "status must be one of")
}

// A tool failure must come back as a readable tool error, not a transport
// failure, so the agent can explain what went wrong.
func TestHostedMCPReportsMissingTicketsAsToolErrors(t *testing.T) {
	f := testutil.NewFixture(t)
	session := connectMCP(t, f, f.Slug, f.AgentToken("agent"))

	text, isErr := callTool(t, session, "velvet_get_ticket", map[string]any{"key": "ENG-999"})
	require.True(t, isErr)
	require.NotEmpty(t, text)

	text, isErr = callTool(t, session, "velvet_current_ticket", map[string]any{"branch": "main"})
	require.True(t, isErr)
	require.Contains(t, text, "no issue key found")
}

func mcpInitialize(t *testing.T, f *testutil.Fixture, path string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range header {
		req.Header[k] = v
	}
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

func TestHostedMCPRequiresAValidToken(t *testing.T) {
	f := testutil.NewFixture(t)

	rec := mcpInitialize(t, f, "/api/v1/w/lab/mcp", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	rec = mcpInitialize(t, f, "/api/v1/w/lab/mcp", http.Header{"Authorization": {"Bearer velvet_not_a_real_token"}})
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	// A revoked token stops working immediately.
	token := f.AgentToken("revoked")
	tokens, err := f.Store.ListAPITokens(t.Context(), f.User.ID)
	require.NoError(t, err)
	require.NoError(t, f.Store.DeleteAPIToken(t.Context(), f.User.ID, tokens[0].ID))
	rec = mcpInitialize(t, f, "/api/v1/w/lab/mcp", http.Header{"Authorization": {"Bearer " + token}})
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

// A browser session must never drive agent tools, even from the same origin.
func TestHostedMCPRejectsBrowserCookies(t *testing.T) {
	f := testutil.NewFixture(t)
	rec := mcpInitialize(t, f, "/api/v1/w/lab/mcp", http.Header{
		"Cookie": {(&http.Cookie{Name: auth.CookieName, Value: f.Token}).String()},
		"Origin": {"http://localhost:8080"},
	})
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), "an API token is required for MCP")
}

// An agent pointed at an organisation its person does not belong to learns
// nothing about it, not even that it exists.
func TestHostedMCPIsolatesOrganisations(t *testing.T) {
	f := testutil.NewFixture(t)
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Other', 'other', 'OTH')`)
	require.NoError(t, err)
	token := f.AgentToken("agent")

	for _, slug := range []string{"other", "missing"} {
		rec := mcpInitialize(t, f, "/api/v1/w/"+slug+"/mcp", http.Header{"Authorization": {"Bearer " + token}})
		require.Equal(t, http.StatusNotFound, rec.Code, slug)
	}
}

// A viewer's agent may read but not write, because MCP applies the same role
// rules as the REST API it calls.
func TestHostedMCPKeepsViewerRoleRules(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateIssue(t, f, "Read-only ticket")
	_, err := f.Pool.Exec(t.Context(), `UPDATE membership SET role='viewer' WHERE user_id=$1`, f.User.ID)
	require.NoError(t, err)
	session := connectMCP(t, f, f.Slug, f.AgentToken("viewer agent"))

	text, isErr := callTool(t, session, "velvet_list_issues", nil)
	require.False(t, isErr, text)
	require.Contains(t, text, "Read-only ticket")

	text, isErr = callTool(t, session, "velvet_create_ticket", map[string]any{"title": "Should not exist"})
	require.True(t, isErr)
	require.Contains(t, text, "insufficient permission")
}

// The first agent call is what the onboarding screen waits for.
func TestHostedMCPMarksTheAgentConnected(t *testing.T) {
	f := testutil.NewFixture(t)
	token := f.AgentToken("first agent")

	state, err := f.Store.Onboarding(t.Context(), f.User.ID)
	require.NoError(t, err)
	require.Equal(t, store.OnboardingState{HasOrganisation: true, HasToken: true, AgentConnected: false}, state)

	session := connectMCP(t, f, f.Slug, token)
	_, isErr := callTool(t, session, "velvet_where_am_i", nil)
	require.False(t, isErr)

	state, err = f.Store.Onboarding(t.Context(), f.User.ID)
	require.NoError(t, err)
	require.True(t, state.AgentConnected)
}

// What an agent is told on connect becomes part of its system prompt, so it
// names this organisation and its projects, and how to choose between them.
func TestHostedMCPInstructionsNameTheOrganisationAndProjects(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, project := range []map[string]any{
		{"key": "velvet", "name": "Velvet app"},
		{"key": "billing", "name": "Billing"},
		{"key": "old-site", "name": "Old site"},
	} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects", project)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}
	rec := f.Do(http.MethodPatch, "/api/v1/w/lab/projects/old-site", map[string]any{"status": "archived"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	session := connectMCP(t, f, f.Slug, f.AgentToken("instructions agent"))
	instructions := session.InitializeResult().Instructions

	require.Contains(t, instructions, "("+f.Slug+")")
	require.Contains(t, instructions, "velvet_log_work")
	require.Contains(t, instructions, "velvet_current_ticket")
	require.Contains(t, instructions, `"Velvet work log" section`)
	require.Contains(t, instructions, "velvet (Velvet app)")
	require.Contains(t, instructions, "billing (Billing)")
	require.NotContains(t, instructions, "old-site", "archived projects are not offered")
	require.Contains(t, instructions, "never invent time spent")
}

func TestHostedMCPInstructionsWithoutProjectsOrWriteAccess(t *testing.T) {
	f := testutil.NewFixture(t)
	session := connectMCP(t, f, f.Slug, f.AgentToken("empty agent"))
	require.Contains(t, session.InitializeResult().Instructions, "has no projects yet")

	_, err := f.Pool.Exec(t.Context(), `UPDATE membership SET role='viewer' WHERE user_id=$1`, f.User.ID)
	require.NoError(t, err)
	session = connectMCP(t, f, f.Slug, f.AgentToken("viewer instructions agent"))
	instructions := session.InitializeResult().Instructions
	require.Contains(t, instructions, "viewer")
	require.Contains(t, instructions, "cannot write")
	require.NotContains(t, instructions, "After each meaningful unit of work")
}

// A large organisation cannot flood an agent's context with its project list.
func TestHostedMCPInstructionsCapTheProjectList(t *testing.T) {
	f := testutil.NewFixture(t)
	for i := range 30 {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects",
			map[string]any{"key": fmt.Sprintf("p%02d", i), "name": fmt.Sprintf("Project %02d", i)})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}
	session := connectMCP(t, f, f.Slug, f.AgentToken("busy agent"))
	instructions := session.InitializeResult().Instructions
	require.Contains(t, instructions, "p00 (Project 00)")
	require.NotContains(t, instructions, "p29 (Project 29)")
	require.Contains(t, instructions, "and 5 more from velvet_list_projects")
}
