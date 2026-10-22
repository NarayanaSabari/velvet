package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
)

const adminUsage = `Usage: velvet admin RESOURCE ACTION [arguments] --server URL --account ID --organisation SLUG

Personal management consent is required: velvet admin login. Repository YAML,
setup credentials, and VELVET_TOKEN never select a management credential.
Flags may precede or follow positional arguments.

  members list | set-role MEMBERSHIP_ID ROLE --yes | remove MEMBERSHIP_ID --yes
  invites list | create EMAIL ROLE | resend INVITE_ID | revoke INVITE_ID --yes
  organisation show | update --name NAME | delete --yes | leave --yes
  projects list [--include-archived] | show KEY
  projects create KEY --name NAME [--description TEXT]
  projects update KEY [--name NAME] [--description TEXT] [--status active|archived]
  projects archive KEY --yes
  github status | repositories | sync | connect | identity | link | unlink --yes
  github map-repository REPO_ID --project-id ID | unmap-repository REPO_ID --yes
  reports activity [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  reports milestones | closed | stale [--days N]
  mentions list [--unread] | read COMMENT_ID... | read --all --yes

Reports and mentions are organisation-wide management views, not repository views.
GitHub connect/link print a trusted browser start URL. Sign in there and finish
GitHub consent yourself. The CLI cannot replace browser OAuth or installation.
`

type adminOptions struct {
	values   map[string]string
	switches map[string]bool
	args     []string
}

// parseAdminOptions accepts flags anywhere without interpreting IDs as flags.
func parseAdminOptions(args []string) (adminOptions, error) {
	o := adminOptions{values: map[string]string{}, switches: map[string]bool{}}
	boolean := map[string]bool{"yes": true, "include-archived": true, "unread": true, "all": true}
	valued := map[string]bool{"server": true, "account": true, "organisation": true, "name": true, "description": true, "status": true, "project-id": true, "from": true, "to": true, "days": true}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			o.args = append(o.args, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "--") {
			o.args = append(o.args, arg)
			continue
		}
		key, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		if _, exists := o.values[key]; exists {
			return o, fail(exitUsage, "duplicate --%s", key)
		}
		if o.switches[key] {
			return o, fail(exitUsage, "duplicate --%s", key)
		}
		if boolean[key] {
			if hasValue {
				return o, fail(exitUsage, "--%s takes no value", key)
			}
			o.switches[key] = true
			continue
		}
		if !valued[key] {
			return o, fail(exitUsage, "unknown admin flag --%s", key)
		}
		if !hasValue {
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "--") {
				return o, fail(exitUsage, "--%s needs a value", key)
			}
			value = args[i]
		}
		o.values[key] = value
	}
	return o, nil
}

func runAdminCommand(args []string, out, errOut io.Writer, in io.Reader) error {
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "help" || args[0] == "-h")) {
		_, err := io.WriteString(out, adminUsage)
		return err
	}
	o, err := parseAdminOptions(args)
	if err != nil {
		return err
	}
	for _, key := range []string{"server", "account", "organisation"} {
		if strings.TrimSpace(o.values[key]) == "" {
			return fail(exitUsage, "admin workspace operations require explicit --%s", key)
		}
	}
	// Validate the full command before loading any private credential or making requests.
	request, err := buildAdminRequest(o)
	if err != nil {
		return err
	}
	e, err := loadManagementEnv(o.values["server"], o.values["account"], out, errOut)
	if err != nil {
		return err
	}
	return executeAdminRequest(e, o, request)
}

type adminRequest struct {
	method, path string
	query        url.Values
	body         any
	browser      bool
	organisation bool
}

func buildAdminRequest(o adminOptions) (adminRequest, error) {
	r := adminRequest{method: http.MethodGet, query: url.Values{}}
	if len(o.args) < 2 {
		return r, fail(exitUsage, "choose an admin resource and action; run velvet admin --help")
	}
	resource, action := o.args[0], o.args[1]
	args := o.args[2:]
	need := func(n int) error {
		if len(args) != n {
			return fail(exitUsage, "admin %s %s needs %d positional arguments", resource, action, n)
		}
		return nil
	}
	yes := func() error {
		if !o.switches["yes"] {
			return fail(exitUsage, "admin %s %s requires --yes", resource, action)
		}
		return nil
	}
	required := func(key string) error {
		if strings.TrimSpace(o.values[key]) == "" {
			return fail(exitUsage, "--%s is required", key)
		}
		return nil
	}
	role := func(s string) bool { return s == "admin" || s == "member" || s == "viewer" }
	// Reject irrelevant flags rather than silently ignoring a scope or mutation selector.
	allowed := ""
	switch resource + " " + action {
	case "members list":
		r.path = "/memberships"
	case "members set-role":
		if err := need(2); err != nil {
			return r, err
		}
		if !role(args[1]) {
			return r, fail(exitUsage, "role must be admin, member, or viewer")
		}
		if err := yes(); err != nil {
			return r, err
		}
		r.method = http.MethodPatch
		r.path = "/memberships/" + url.PathEscape(args[0])
		r.body = map[string]string{"role": args[1]}
		allowed = "yes"
	case "members remove", "invites revoke":
		if err := need(1); err != nil {
			return r, err
		}
		if err := yes(); err != nil {
			return r, err
		}
		r.method = http.MethodDelete
		prefix := "/memberships/"
		if resource == "invites" {
			prefix = "/invites/"
		}
		r.path = prefix + url.PathEscape(args[0])
		allowed = "yes"
	case "invites list":
		r.path = "/invites"
	case "invites create":
		if err := need(2); err != nil {
			return r, err
		}
		if !role(args[1]) {
			return r, fail(exitUsage, "role must be admin, member, or viewer")
		}
		r.method = http.MethodPost
		r.path = "/invites"
		r.body = map[string]string{"email": args[0], "role": args[1]}
	case "invites resend":
		if err := need(1); err != nil {
			return r, err
		}
		r.method = http.MethodPost
		r.path = "/invites/" + url.PathEscape(args[0]) + "/resend"
	case "organisation show":
		r.path = "/me"
		r.organisation = true
	case "organisation update":
		if err := required("name"); err != nil {
			return r, err
		}
		r.method = http.MethodPatch
		r.body = map[string]string{"name": o.values["name"]}
		allowed = "name"
	case "organisation delete", "organisation leave":
		if err := yes(); err != nil {
			return r, err
		}
		allowed = "yes"
		r.method = http.MethodDelete
		r.body = map[string]string{"confirm": o.values["organisation"]}
		if action == "leave" {
			r.method = http.MethodPost
			r.path = "/leave"
			r.body = nil
		}
	case "projects list":
		r.path = "/projects"
		allowed = "include-archived"
		if o.switches["include-archived"] {
			r.query.Set("include_archived", "true")
		}
	case "projects show":
		if err := need(1); err != nil {
			return r, err
		}
		r.path = "/projects/" + url.PathEscape(args[0])
	case "projects create", "projects update", "projects archive":
		if err := need(1); err != nil {
			return r, err
		}
		r.path = "/projects/" + url.PathEscape(args[0])
		r.method = http.MethodPatch
		body := map[string]string{}
		allowed = "name description status"
		for _, k := range []string{"name", "description", "status"} {
			if v, ok := o.values[k]; ok {
				body[k] = v
			}
		}
		if v, ok := body["name"]; ok && strings.TrimSpace(v) == "" {
			return r, fail(exitUsage, "name must not be empty")
		}
		if action == "create" {
			if err := required("name"); err != nil {
				return r, err
			}
			r.method = http.MethodPost
			r.path = "/projects"
			body["key"] = args[0]
			allowed = "name description"
		}
		if action == "archive" {
			if err := yes(); err != nil {
				return r, err
			}
			body["status"] = "archived"
			allowed = "yes"
		}
		if s, ok := body["status"]; ok {
			if s != "active" && s != "archived" {
				return r, fail(exitUsage, "status must be active or archived")
			}
			if s == "archived" {
				if err := yes(); err != nil {
					return r, err
				}
				allowed += " yes"
			}
		}
		if len(body) == 0 {
			return r, fail(exitUsage, "provide at least one project field")
		}
		r.body = body
	case "github status":
		r.path = "/github"
	case "github repositories":
		r.path = "/repos"
	case "github sync":
		r.method = http.MethodPost
		r.path = "/github/sync"
	case "github connect":
		r.path = "/github/connect"
		r.browser = true
	case "github identity":
		r.path = "/me/github"
	case "github link":
		r.path = "/me/github/link"
		r.browser = true
	case "github unlink":
		if err := yes(); err != nil {
			return r, err
		}
		r.path = "/me/github"
		r.method = http.MethodDelete
		allowed = "yes"
	case "github map-repository", "github unmap-repository":
		if err := need(1); err != nil {
			return r, err
		}
		r.method = http.MethodPut
		r.path = "/repos/" + url.PathEscape(args[0]) + "/project"
		var project any
		if action == "map-repository" {
			if err := required("project-id"); err != nil {
				return r, err
			}
			project = o.values["project-id"]
			allowed = "project-id"
		} else {
			if err := yes(); err != nil {
				return r, err
			}
			allowed = "yes"
		}
		r.body = map[string]any{"project_id": project}
	case "reports activity", "reports milestones", "reports closed", "reports stale":
		r.path = "/reports/" + action
		if action == "activity" {
			allowed = "from to"
			for _, k := range []string{"from", "to"} {
				if v, ok := o.values[k]; ok {
					if _, err := time.Parse("2006-01-02", v); err != nil {
						return r, fail(exitUsage, "--%s must be YYYY-MM-DD", k)
					}
					r.query.Set(k, v)
				}
			}
		}
		if action == "stale" {
			allowed = "days"
			if v, ok := o.values["days"]; ok {
				n, err := strconv.Atoi(v)
				if err != nil || n < 1 || n > 365 {
					return r, fail(exitUsage, "--days must be between 1 and 365")
				}
				r.query.Set("days", v)
			}
		}
	case "mentions list":
		r.path = "/mentions"
		allowed = "unread"
		if o.switches["unread"] {
			r.query.Set("unread", "true")
		}
	case "mentions read":
		r.path = "/mentions/read"
		r.method = http.MethodPost
		allowed = "all yes"
		if o.switches["all"] {
			if err := need(0); err != nil {
				return r, err
			}
			if err := yes(); err != nil {
				return r, err
			}
		} else if len(args) == 0 {
			return r, fail(exitUsage, "provide comment IDs or --all --yes")
		}
		ids := append([]string{}, args...)
		r.body = map[string]any{"comment_ids": ids}
	default:
		return r, fail(exitUsage, "unknown admin operation %q; run velvet admin --help", resource+" "+action)
	}
	// Commands with arguments above enforce their own arity.
	takesArgs := map[string]bool{"members set-role": true, "members remove": true, "invites create": true, "invites resend": true, "invites revoke": true, "projects show": true, "projects create": true, "projects update": true, "projects archive": true, "github map-repository": true, "github unmap-repository": true, "mentions read": true}
	if !takesArgs[resource+" "+action] {
		if err := need(0); err != nil {
			return r, err
		}
	}
	allowedSet := map[string]bool{"server": true, "account": true, "organisation": true}
	for _, k := range strings.Fields(allowed) {
		allowedSet[k] = true
	}
	for k := range o.values {
		if !allowedSet[k] {
			return r, fail(exitUsage, "--%s is not supported for %s %s", k, resource, action)
		}
	}
	for k := range o.switches {
		if !allowedSet[k] {
			return r, fail(exitUsage, "--%s is not supported for %s %s", k, resource, action)
		}
	}
	return r, nil
}

func executeAdminRequest(e *env, o adminOptions, r adminRequest) error {
	base := "/w/" + url.PathEscape(o.values["organisation"])
	if r.browser {
		_, err := fmt.Fprintf(e.out, "Open this trusted server URL in your browser, sign in, and complete GitHub consent/install there:\n%s/api/v1%s%s\n", strings.TrimRight(e.api.Base, "/"), base, r.path)
		return err
	}
	path := base + r.path
	if r.organisation {
		path = r.path
	}
	var result any
	err := e.api.Do(r.method, path, r.query, r.body, &result)
	if err != nil {
		var ce *client.Error
		if r.path == "/github/sync" && errors.As(err, &ce) && ce.Status == http.StatusAccepted {
			result = map[string]string{"status": "syncing"}
		} else {
			return managementRequestError(err)
		}
	}
	if r.organisation {
		data, ok := result.(map[string]any)
		if !ok {
			return fail(exitAPI, "invalid organisation membership response")
		}
		memberships, _ := data["memberships"].([]any)
		result = nil
		for _, raw := range memberships {
			m, ok := raw.(map[string]any)
			if ok && m["workspace_slug"] == o.values["organisation"] {
				result = m
				break
			}
		}
		if result == nil {
			return fail(exitNotFound, "no membership in organisation %q", o.values["organisation"])
		}
	}
	if result == nil {
		result = map[string]bool{"ok": true}
	}
	encoder := json.NewEncoder(e.out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func managementRequestError(err error) error {
	var ce *client.Error
	if !errors.As(err, &ce) {
		return fail(exitNetwork, "%s", err)
	}
	switch ce.Status {
	case http.StatusUnauthorized:
		return fail(exitAuth, "management credential is invalid or revoked; run velvet admin login")
	case http.StatusForbidden:
		return fail(exitAuth, "%s", ce)
	case http.StatusNotFound:
		return fail(exitNotFound, "%s", ce)
	default:
		return fail(exitAPI, "%s", ce)
	}
}
