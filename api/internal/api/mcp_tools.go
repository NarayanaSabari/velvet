package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var mcpDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// The wire shapes the tools read back. Only the fields a tool prints are
// declared, so a new API field never breaks an agent.
type mcpUser struct {
	Name        string  `json:"name"`
	Email       string  `json:"email"`
	GitHubLogin *string `json:"github_login"`
}

type mcpComment struct {
	Body      string       `json:"body"`
	CreatedAt string       `json:"created_at"`
	Author    mcpUser      `json:"author"`
	Replies   []mcpComment `json:"replies"`
}

type mcpIssue struct {
	Key         string  `json:"key"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Priority    int     `json:"priority"`
	AssigneeID  *string `json:"assignee_id"`
	MilestoneID *string `json:"milestone_id"`
}

type mcpProject struct {
	Key         string         `json:"key"`
	Name        string         `json:"name"`
	IssueCounts map[string]int `json:"issue_counts"`
}

type mcpSprint struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	State    string `json:"state"`
}

type mcpMilestone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type mcpWorklogEntry struct {
	Day           string  `json:"day"`
	WorkspaceSlug string  `json:"workspace_slug"`
	WorkspaceName string  `json:"workspace_name"`
	ProjectKey    *string `json:"project_key"`
	Kind          string  `json:"kind"`
	IssueKey      *string `json:"issue_key"`
	Title         string  `json:"title"`
	Body          string  `json:"body"`
	Status        string  `json:"status"`
}

// Tool inputs. Descriptions come from the jsonschema tag; omitempty marks a
// field optional in the published schema.
type logWorkInput struct {
	Body    string `json:"body" jsonschema:"The factual 1-3 sentence work-log entry"`
	Key     string `json:"key,omitempty" jsonschema:"Velvet issue key, such as ENG-42"`
	Project string `json:"project,omitempty" jsonschema:"Project key, when there is no ticket"`
	Kind    string `json:"kind,omitempty" jsonschema:"progress, decision, blocker, or note"`
}

type currentTicketInput struct {
	Branch string `json:"branch" jsonschema:"The current Git branch name, from git branch --show-current"`
}

type noInput struct{}

type createTicketInput struct {
	Title       string `json:"title" jsonschema:"Short ticket title"`
	Description string `json:"description,omitempty" jsonschema:"Optional ticket description"`
	Status      string `json:"status,omitempty" jsonschema:"Optional status: backlog, todo, in_progress, in_review, done, or cancelled"`
	Priority    *int   `json:"priority,omitempty" jsonschema:"Optional priority from 0 through 4"`
	Project     string `json:"project,omitempty" jsonschema:"Optional project key to file the ticket under"`
	MilestoneID string `json:"milestone_id,omitempty" jsonschema:"Optional milestone ID"`
}

type keyInput struct {
	Key string `json:"key" jsonschema:"Velvet issue key, such as ENG-42"`
}

type attachEvidenceInput struct {
	Key       string `json:"key" jsonschema:"Velvet issue key, such as ENG-42"`
	Reference string `json:"reference" jsonschema:"A pull request URL, owner/repo#number, or a commit sha"`
}

type worklogInput struct {
	Days      int    `json:"days,omitempty" jsonschema:"How many days back, default 7"`
	Workspace string `json:"workspace,omitempty" jsonschema:"Limit to one organisation slug"`
	Project   string `json:"project,omitempty" jsonschema:"Limit to one project key"`
}

type listIssuesInput struct {
	Status  string `json:"status,omitempty" jsonschema:"Optional status filter"`
	Mine    bool   `json:"mine,omitempty" jsonschema:"Only tickets assigned to the authenticated person"`
	Project string `json:"project,omitempty" jsonschema:"Only tickets filed under this project key"`
}

type updateTicketInput struct {
	Key         string  `json:"key" jsonschema:"Velvet issue key, such as ENG-42"`
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Priority    *int    `json:"priority,omitempty"`
	Project     *string `json:"project,omitempty" jsonschema:"Project key, or an empty string to unfile it"`
	MilestoneID *string `json:"milestone_id,omitempty" jsonschema:"Milestone ID to schedule into, or an empty string to unschedule"`
}

type setStatusInput struct {
	Key    string `json:"key" jsonschema:"Velvet issue key, such as ENG-42"`
	Status string `json:"status" jsonschema:"New status: backlog, todo, in_progress, in_review, done, or cancelled"`
}

type createSprintInput struct {
	Name     string `json:"name" jsonschema:"Sprint name, such as September 2026"`
	StartsOn string `json:"starts_on" jsonschema:"First day, YYYY-MM-DD"`
	EndsOn   string `json:"ends_on" jsonschema:"Last day, YYYY-MM-DD"`
}

type createMilestoneInput struct {
	SprintID    string `json:"sprint_id" jsonschema:"Sprint ID from velvet_list_sprints"`
	Name        string `json:"name" jsonschema:"What this milestone is"`
	Description string `json:"description,omitempty"`
	TargetDate  string `json:"target_date,omitempty" jsonschema:"Target date, YYYY-MM-DD"`
}

// tool registers one handler that always returns text, turning any error into
// a tool error the agent can read rather than a protocol failure.
func tool[In any](server *mcp.Server, baseURL string, api http.Handler, name, description string,
	run func(context.Context, *mcpCall, In) (string, error)) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description},
		func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
			call, err := newMCPCall(ctx, baseURL, api)
			if err != nil {
				return nil, nil, err
			}
			text, err := run(ctx, call, in)
			if err != nil {
				return nil, nil, err
			}
			return mcpText(text), nil, nil
		})
}

func registerMCPTools(server *mcp.Server, baseURL string, api http.Handler) {
	tool(server, baseURL, api, "velvet_where_am_i",
		"Report which Velvet organisation this agent writes to, the person it acts as, and their role.",
		func(ctx context.Context, c *mcpCall, _ noInput) (string, error) {
			var me struct {
				User mcpUser `json:"user"`
			}
			if err := c.do(ctx, http.MethodGet, "/api/v1/me", nil, &me); err != nil {
				return "", err
			}
			who := mcpLine(me.User.Name, mcpLine(me.User.Email, "unknown"))
			return fmt.Sprintf("Organisation: %s (%s)\nIssue prefix: %s\nRole: %s\nSigned in as %s",
				c.membership.Name, c.slug(), c.membership.IssuePrefix, c.membership.Role, who), nil
		})

	tool(server, baseURL, api, "velvet_log_work",
		"Write a factual 1-3 sentence work-log entry after completing a meaningful unit of work. Supply a ticket "+
			"key when one exists, otherwise a project key. Never skip logging because no ticket exists, and never invent time spent.",
		func(ctx context.Context, c *mcpCall, in logWorkInput) (string, error) {
			body := strings.TrimSpace(in.Body)
			if body == "" {
				return "", errors.New("body must not be empty")
			}
			if in.Kind != "" && !oneOf(in.Kind, mcpNoteKinds) {
				return "", errors.New("kind must be progress, decision, blocker, or note")
			}
			base := c.scoped()
			payload := map[string]any{"body": body}
			if in.Kind != "" {
				payload["kind"] = in.Kind
			}
			var comment mcpComment
			if key := mcpKey(in.Key); key != "" {
				if err := c.do(ctx, http.MethodPost, base+"/issues/"+url.PathEscape(key)+"/comments", payload, &comment); err != nil {
					return "", err
				}
				return fmt.Sprintf("Logged work to %s: %s", key, mcpLine(comment.Body, "(empty)")), nil
			}
			project := strings.TrimSpace(in.Project)
			if project == "" {
				return "", errors.New("pass a ticket key, or a project key when there is no ticket (see velvet_list_projects)")
			}
			if err := c.do(ctx, http.MethodPost, base+"/projects/"+url.PathEscape(project)+"/comments", payload, &comment); err != nil {
				return "", err
			}
			return fmt.Sprintf("Logged work to project %s: %s", project, mcpLine(comment.Body, "(empty)")), nil
		})

	tool(server, baseURL, api, "velvet_current_ticket",
		"Extract an issue key such as ENG-42 from the current Git branch name and fetch that ticket. Pass the "+
			"output of git branch --show-current.",
		func(ctx context.Context, c *mcpCall, in currentTicketInput) (string, error) {
			match := mcpIssueKey.FindStringSubmatch(in.Branch)
			if match == nil {
				return "", fmt.Errorf("no issue key found in branch %q; use a branch such as feature/ENG-42-fix, or log work against a project", in.Branch)
			}
			return c.ticket(ctx, strings.ToUpper(match[1]))
		})

	tool(server, baseURL, api, "velvet_get_ticket",
		"Fetch a ticket and its approximately ten most recent work-log entries.",
		func(ctx context.Context, c *mcpCall, in keyInput) (string, error) {
			return c.ticket(ctx, mcpKey(in.Key))
		})

	tool(server, baseURL, api, "velvet_create_ticket",
		"Create a ticket in the organisation and return its key and URL.",
		func(ctx context.Context, c *mcpCall, in createTicketInput) (string, error) {
			if strings.TrimSpace(in.Title) == "" {
				return "", errors.New("title is required")
			}
			if in.Status != "" && !oneOf(in.Status, mcpIssueStatuses) {
				return "", errors.New("status must be one of " + strings.Join(mcpIssueStatuses, ", "))
			}
			base := c.scoped()
			payload := map[string]any{"title": strings.TrimSpace(in.Title)}
			if in.Description != "" {
				payload["description"] = in.Description
			}
			if in.Status != "" {
				payload["status"] = in.Status
			}
			if in.Priority != nil {
				payload["priority"] = *in.Priority
			}
			if in.Project != "" {
				payload["project"] = in.Project
			}
			if in.MilestoneID != "" {
				payload["milestone_id"] = in.MilestoneID
			}
			var issue mcpIssue
			if err := c.do(ctx, http.MethodPost, base+"/issues", payload, &issue); err != nil {
				return "", err
			}
			return fmt.Sprintf("Created %s: %s\nStatus: %s\nURL: %s", issue.Key, mcpLine(issue.Title, "(untitled)"),
				issue.Status, c.issueURL(issue.Key)), nil
		})

	tool(server, baseURL, api, "velvet_list_issues",
		"List compact ticket key, title, status, and assignee information in the organisation.",
		func(ctx context.Context, c *mcpCall, in listIssuesInput) (string, error) {
			if in.Status != "" && !oneOf(in.Status, mcpIssueStatuses) {
				return "", errors.New("status must be one of " + strings.Join(mcpIssueStatuses, ", "))
			}
			base := c.scoped()
			query := url.Values{}
			if in.Status != "" {
				query.Set("status", in.Status)
			}
			if in.Project != "" {
				query.Set("project", in.Project)
			}
			if in.Mine {
				var me struct {
					User struct {
						ID string `json:"id"`
					} `json:"user"`
				}
				if err := c.do(ctx, http.MethodGet, "/api/v1/me", nil, &me); err != nil {
					return "", err
				}
				query.Set("assignee_id", me.User.ID)
			}
			path := base + "/issues"
			if encoded := query.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var list struct {
				Issues []mcpIssue `json:"issues"`
			}
			if err := c.do(ctx, http.MethodGet, path, nil, &list); err != nil {
				return "", err
			}
			if len(list.Issues) == 0 {
				return fmt.Sprintf("No issues found in %s.", c.slug()), nil
			}
			lines := []string{"Issues in " + c.slug() + ":"}
			for _, issue := range list.Issues {
				lines = append(lines, fmt.Sprintf("%s | %s | %s | assignee: %s", issue.Key, issue.Status,
					mcpLine(issue.Title, "(untitled)"), assigneeOf(issue)))
			}
			return strings.Join(lines, "\n"), nil
		})

	tool(server, baseURL, api, "velvet_update_ticket",
		"Update a ticket title, description, priority, project, or milestone. Status is deliberately excluded: "+
			"use velvet_set_status, and only when the person asks.",
		func(ctx context.Context, c *mcpCall, in updateTicketInput) (string, error) {
			base := c.scoped()
			payload := map[string]any{}
			if in.Title != nil {
				payload["title"] = *in.Title
			}
			if in.Description != nil {
				payload["description"] = *in.Description
			}
			if in.Priority != nil {
				payload["priority"] = *in.Priority
			}
			if in.Project != nil {
				payload["project"] = *in.Project
			}
			if in.MilestoneID != nil {
				if *in.MilestoneID == "" {
					payload["milestone_id"] = nil
				} else {
					payload["milestone_id"] = *in.MilestoneID
				}
			}
			if len(payload) == 0 {
				return "", errors.New("nothing to update: pass at least one field")
			}
			var issue mcpIssue
			if err := c.do(ctx, http.MethodPatch, base+"/issues/"+url.PathEscape(mcpKey(in.Key)), payload, &issue); err != nil {
				return "", err
			}
			return fmt.Sprintf("Updated %s: %s", issue.Key, mcpLine(issue.Title, "(untitled)")), nil
		})

	tool(server, baseURL, api, "velvet_set_status",
		"Set a ticket status only on an explicit request from the person. Never call this automatically, and never "+
			"because a pull request was merged.",
		func(ctx context.Context, c *mcpCall, in setStatusInput) (string, error) {
			if !oneOf(in.Status, mcpIssueStatuses) {
				return "", errors.New("status must be one of " + strings.Join(mcpIssueStatuses, ", "))
			}
			base := c.scoped()
			var issue mcpIssue
			if err := c.do(ctx, http.MethodPatch, base+"/issues/"+url.PathEscape(mcpKey(in.Key)),
				map[string]any{"status": in.Status}, &issue); err != nil {
				return "", err
			}
			return fmt.Sprintf("%s status set to %s.", issue.Key, issue.Status), nil
		})

	tool(server, baseURL, api, "velvet_attach_evidence",
		"Attach a pull request or commit to a ticket as proof of work. Accepts a PR URL, owner/repo#number, or a "+
			"commit sha. This never changes the ticket status.",
		func(ctx context.Context, c *mcpCall, in attachEvidenceInput) (string, error) {
			base := c.scoped()
			key := mcpKey(in.Key)
			var ref struct {
				Kind string `json:"kind"`
				SHA  string `json:"sha"`
				URL  string `json:"url"`
			}
			if err := c.do(ctx, http.MethodPost, base+"/issues/"+url.PathEscape(key)+"/evidence",
				map[string]any{"reference": strings.TrimSpace(in.Reference)}, &ref); err != nil {
				return "", err
			}
			what := "pull request"
			if ref.Kind == "commit" {
				what = "commit " + ref.SHA
			}
			suffix := ""
			if ref.URL != "" {
				suffix = " (" + ref.URL + ")"
			}
			return fmt.Sprintf("Attached %s to %s as evidence%s. Status unchanged.", what, key, suffix), nil
		})

	tool(server, baseURL, api, "velvet_my_worklog",
		"Summarise what the person worked on across every organisation they belong to. Use this to answer "+
			"\"what was I working on\" or to prepare a status update.",
		func(ctx context.Context, c *mcpCall, in worklogInput) (string, error) {
			query := url.Values{}
			if in.Days > 0 {
				query.Set("days", strconv.Itoa(min(in.Days, 365)))
			}
			if in.Workspace != "" {
				query.Set("workspace", in.Workspace)
			}
			if in.Project != "" {
				query.Set("project", in.Project)
			}
			path := "/api/v1/me/worklog"
			if encoded := query.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var log struct {
				Entries []mcpWorklogEntry `json:"entries"`
			}
			if err := c.do(ctx, http.MethodGet, path, nil, &log); err != nil {
				return "", err
			}
			return formatMCPWorklog(log.Entries), nil
		})

	tool(server, baseURL, api, "velvet_list_projects",
		"List the projects in the organisation, so work can be filed under a durable goal.",
		func(ctx context.Context, c *mcpCall, _ noInput) (string, error) {
			base := c.scoped()
			var list struct {
				Projects []mcpProject `json:"projects"`
			}
			if err := c.do(ctx, http.MethodGet, base+"/projects", nil, &list); err != nil {
				return "", err
			}
			if len(list.Projects) == 0 {
				return fmt.Sprintf("No projects in %s yet. Create one in Velvet before filing work under a goal.", c.slug()), nil
			}
			lines := []string{"Projects in " + c.slug() + ":"}
			for _, p := range list.Projects {
				line := p.Key + " | " + mcpLine(p.Name, "(unnamed)")
				if counts := sortedCounts(p.IssueCounts); counts != "" {
					line += " | " + counts
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n"), nil
		})

	tool(server, baseURL, api, "velvet_list_sprints",
		"List the sprints in the organisation with their state and dates, so work can be scheduled into the month it belongs to.",
		func(ctx context.Context, c *mcpCall, _ noInput) (string, error) {
			base := c.scoped()
			var list struct {
				Sprints []mcpSprint `json:"sprints"`
			}
			if err := c.do(ctx, http.MethodGet, base+"/sprints", nil, &list); err != nil {
				return "", err
			}
			if len(list.Sprints) == 0 {
				return fmt.Sprintf("No sprints in %s.", c.slug()), nil
			}
			lines := []string{"Sprints in " + c.slug() + ":"}
			for _, s := range list.Sprints {
				lines = append(lines, fmt.Sprintf("%s | %s | %s | %s to %s", s.ID, mcpLine(s.Name, "(unnamed)"), s.State, s.StartsOn, s.EndsOn))
			}
			return strings.Join(lines, "\n"), nil
		})

	tool(server, baseURL, api, "velvet_create_sprint",
		"Create a sprint, the calendar window work is scheduled into. A new sprint starts upcoming and is not activated automatically.",
		func(ctx context.Context, c *mcpCall, in createSprintInput) (string, error) {
			if !mcpDate.MatchString(in.StartsOn) || !mcpDate.MatchString(in.EndsOn) {
				return "", errors.New("starts_on and ends_on must be YYYY-MM-DD")
			}
			base := c.scoped()
			var sprint mcpSprint
			if err := c.do(ctx, http.MethodPost, base+"/sprints",
				map[string]any{"name": in.Name, "starts_on": in.StartsOn, "ends_on": in.EndsOn}, &sprint); err != nil {
				return "", err
			}
			return fmt.Sprintf("Created sprint %s (%s to %s).\nID: %s\nState: %s. Activate it when work starts.",
				mcpLine(sprint.Name, "(unnamed)"), sprint.StartsOn, sprint.EndsOn, sprint.ID, sprint.State), nil
		})

	tool(server, baseURL, api, "velvet_create_milestone",
		"Create a milestone inside a sprint. A milestone is the goal work is filed under with milestone_id.",
		func(ctx context.Context, c *mcpCall, in createMilestoneInput) (string, error) {
			if in.TargetDate != "" && !mcpDate.MatchString(in.TargetDate) {
				return "", errors.New("target_date must be YYYY-MM-DD")
			}
			base := c.scoped()
			payload := map[string]any{"name": in.Name}
			if in.Description != "" {
				payload["description"] = in.Description
			}
			if in.TargetDate != "" {
				payload["target_date"] = in.TargetDate
			}
			var milestone mcpMilestone
			if err := c.do(ctx, http.MethodPost, base+"/sprints/"+url.PathEscape(in.SprintID)+"/milestones", payload, &milestone); err != nil {
				return "", err
			}
			return fmt.Sprintf("Created milestone %s.\nID: %s\nFile tickets under it with milestone_id.",
				mcpLine(milestone.Name, "(unnamed)"), milestone.ID), nil
		})

	tool(server, baseURL, api, "velvet_list_milestones",
		"List milestone IDs and names so a new ticket can be filed under a sprint goal.",
		func(ctx context.Context, c *mcpCall, _ noInput) (string, error) {
			base := c.scoped()
			var list struct {
				Milestones []mcpMilestone `json:"milestones"`
			}
			if err := c.do(ctx, http.MethodGet, base+"/milestones", nil, &list); err != nil {
				return "", err
			}
			if len(list.Milestones) == 0 {
				return fmt.Sprintf("No milestones in %s.", c.slug()), nil
			}
			lines := []string{"Milestones in " + c.slug() + ":"}
			for _, m := range list.Milestones {
				line := m.ID + " | " + mcpLine(m.Name, "(unnamed)")
				if m.Status != "" {
					line += " | " + m.Status
				}
				lines = append(lines, line)
			}
			return strings.Join(lines, "\n"), nil
		})
}

// ticket fetches one issue and its recent comments as compact text.
func (c *mcpCall) ticket(ctx context.Context, key string) (string, error) {
	path := c.scoped() + "/issues/" + url.PathEscape(key)
	var issue mcpIssue
	if err := c.do(ctx, http.MethodGet, path, nil, &issue); err != nil {
		return "", err
	}
	var thread struct {
		Comments []mcpComment `json:"comments"`
	}
	if err := c.do(ctx, http.MethodGet, path+"/comments", nil, &thread); err != nil {
		return "", err
	}
	lines := []string{
		fmt.Sprintf("%s: %s", issue.Key, mcpLine(issue.Title, "(untitled)")),
		"Organisation: " + c.slug(),
		"Status: " + issue.Status,
		fmt.Sprintf("Priority: %d", issue.Priority),
		"Assignee: " + assigneeOf(issue),
	}
	if issue.MilestoneID != nil {
		lines = append(lines, "Milestone: "+*issue.MilestoneID)
	}
	if description := strings.TrimSpace(issue.Description); description != "" {
		lines = append(lines, "Description: "+description)
	}
	recent := thread.Comments
	if len(recent) > 10 {
		recent = recent[len(recent)-10:]
	}
	lines = append(lines, fmt.Sprintf("Recent work log (%d):", len(recent)))
	if len(recent) == 0 {
		lines = append(lines, "- (none)")
	}
	for _, comment := range recent {
		lines = append(lines, commentLine(comment, "- "))
		for _, reply := range comment.Replies {
			lines = append(lines, commentLine(reply, "  - "))
		}
	}
	return strings.Join(lines, "\n"), nil
}

func assigneeOf(issue mcpIssue) string {
	if issue.AssigneeID == nil || *issue.AssigneeID == "" {
		return "unassigned"
	}
	return *issue.AssigneeID
}

func commentLine(comment mcpComment, prefix string) string {
	author := mcpLine(comment.Author.Name, "")
	if author == "" && comment.Author.GitHubLogin != nil {
		author = *comment.Author.GitHubLogin
	}
	author = mcpLine(author, mcpLine(comment.Author.Email, "unknown"))
	stamp := ""
	if comment.CreatedAt != "" {
		stamp = " [" + comment.CreatedAt + "]"
	}
	return prefix + author + stamp + ": " + mcpLine(comment.Body, "(empty)")
}

// formatMCPWorklog groups by day then organisation, which is how a person
// reconstructs their own week.
func formatMCPWorklog(entries []mcpWorklogEntry) string {
	if len(entries) == 0 {
		return "No recorded work in this period."
	}
	var lines []string
	day, workspace := "", ""
	for _, entry := range entries {
		if entry.Day != day {
			day, workspace = entry.Day, ""
			lines = append(lines, entry.Day)
		}
		if entry.WorkspaceSlug != workspace {
			workspace = entry.WorkspaceSlug
			lines = append(lines, "  "+mcpLine(entry.WorkspaceName, entry.WorkspaceSlug))
		}
		var parts []string
		if entry.ProjectKey != nil {
			parts = append(parts, "["+*entry.ProjectKey+"]")
		}
		if entry.IssueKey != nil {
			parts = append(parts, *entry.IssueKey)
		}
		switch entry.Kind {
		case "note":
			parts = append(parts, mcpLine(entry.Body, "(empty)"))
		case "issue":
			parts = append(parts, mcpLine(entry.Title, "(untitled)"))
			if entry.Status != "" {
				parts = append(parts, "("+entry.Status+")")
			}
		case "pull_request":
			parts = append(parts, "PR: "+mcpLine(entry.Title, "(untitled)"))
		case "commit":
			parts = append(parts, "commit: "+mcpLine(entry.Title, "(empty)"))
		default:
			parts = append(parts, mcpLine(entry.Title, "(untitled)"))
		}
		lines = append(lines, "    - "+strings.Join(parts, " "))
	}
	return strings.Join(lines, "\n")
}
