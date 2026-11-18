package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

// runTicketCommand dispatches work commands after loadEnv has verified project credentials.
func runTicketCommand(e *env, cmd string, args []string, in io.Reader) (bool, error) {
	switch cmd {
	case "edit":
		return true, e.editTicket(args)
	case "members":
		return true, e.members(args)
	case "comments":
		return true, e.ticketComments(args, in)
	case "evidence":
		if len(args) != 2 || !looksLikeKey(args[0]) || args[1] != "list" {
			return true, fail(exitUsage, "usage: velvet evidence KEY list")
		}
		return true, e.ticketJSON(e.scoped("/issues/" + url.PathEscape(strings.ToUpper(args[0])) + "/evidence"))
	default:
		return false, nil
	}
}

var ticketUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (e env) editTicket(args []string) error {
	if len(args) < 2 || !looksLikeKey(args[0]) {
		return fail(exitUsage, "usage: velvet edit KEY [--title TEXT] [--desc TEXT] [--priority 0..4] [--assignee NAME|EMAIL|me|UUID|none] [--milestone UUID|none]")
	}
	key := strings.ToUpper(args[0])
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	title := fs.String("title", "", "ticket title")
	desc := fs.String("desc", "", "description; empty clears it")
	priority := fs.Int("priority", 0, "0 (none) to 4")
	assignee := fs.String("assignee", "", "name, email, GitHub login, me, UUID, or none to clear")
	milestone := fs.String("milestone", "", "milestone UUID, or none to clear")
	fs.String("labels", "", "unsupported by the ticket API")
	if err := fs.Parse(args[1:]); err != nil {
		return fail(exitUsage, "%s", err)
	}
	if fs.NArg() != 0 {
		return fail(exitUsage, "unexpected edit arguments: %s", strings.Join(fs.Args(), " "))
	}
	payload := map[string]any{}
	var invalid error
	setAssignee := false
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "title":
			if strings.TrimSpace(*title) == "" {
				invalid = fail(exitUsage, "--title cannot be empty")
			}
			payload["title"] = *title
		case "desc":
			payload["description"] = *desc
		case "priority":
			if *priority < 0 || *priority > 4 {
				invalid = fail(exitUsage, "--priority must be between 0 and 4")
			}
			payload["priority"] = *priority
		case "labels":
			invalid = fail(exitUsage, "--labels is not supported by the ticket API")
		case "assignee":
			setAssignee = true
		case "milestone":
			value := *milestone
			if value == "none" {
				payload["milestone_id"] = nil
			} else if ticketUUID.MatchString(value) {
				payload["milestone_id"] = value
			} else {
				invalid = fail(exitUsage, "--milestone requires a UUID or none to clear")
			}
		}
	})
	if invalid != nil {
		return invalid
	}
	if setAssignee {
		id, err := e.resolveAssignee(*assignee)
		if err != nil {
			return err
		}
		if id == nil {
			payload["assignee_id"] = nil
		} else {
			payload["assignee_id"] = *id
		}
	}
	if len(payload) == 0 {
		return fail(exitUsage, "provide at least one edit flag")
	}
	if err := e.api.Do(http.MethodPatch, e.scoped("/issues/"+url.PathEscape(key)), nil, payload, nil); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "Updated %s. Status unchanged.\n", key)
	return nil
}

// ticketJSON preserves API identifiers, nested replies, and evidence details for agents.
func (e env) ticketJSON(path string) error {
	var data json.RawMessage
	if err := e.api.Do(http.MethodGet, path, nil, nil, &data); err != nil {
		return apiError(err)
	}
	encoder := json.NewEncoder(e.out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(data)
}

func (e env) ticketComments(args []string, in io.Reader) error {
	if len(args) < 2 {
		return fail(exitUsage, "usage: velvet comments (KEY | --project | --milestone UUID) (list | add | edit ID | delete ID --yes)")
	}
	target := ""
	if args[0] == "--milestone" {
		if len(args) < 3 || !ticketUUID.MatchString(args[1]) {
			return fail(exitUsage, "comments --milestone requires a milestone UUID and operation")
		}
		target = "/milestones/" + url.PathEscape(args[1])
		args = args[1:]
	} else if args[0] == "--project" {
		target = "/projects/" + url.PathEscape(e.repo.Project)
	} else if looksLikeKey(args[0]) {
		target = "/issues/" + url.PathEscape(strings.ToUpper(args[0]))
	} else {
		return fail(exitUsage, "comments requires a ticket KEY, --project, or --milestone UUID")
	}
	op, rest := args[1], args[2:]
	if op == "list" {
		if len(rest) != 0 {
			return fail(exitUsage, "comments list takes no arguments")
		}
		return e.ticketJSON(e.scoped(target + "/comments"))
	}
	if op != "add" && op != "edit" && op != "delete" {
		return fail(exitUsage, "unknown comments operation %q; use list, add, edit, delete", op)
	}
	id := ""
	if op != "add" {
		if len(rest) == 0 || !ticketUUID.MatchString(rest[0]) {
			return fail(exitUsage, "comments %s requires a comment UUID", op)
		}
		id, rest = rest[0], rest[1:]
	}
	fs := flag.NewFlagSet("comments "+op, flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	var kind, parent string
	var yes bool
	var images imageFlags
	if op == "add" {
		fs.StringVar(&kind, "kind", "", "progress, decision, blocker, or note")
		fs.StringVar(&parent, "parent", "", "parent comment UUID")
		fs.Var(&images, "image", "PATH#caption to attach to the new comment; repeatable")
	}
	if op == "delete" {
		fs.BoolVar(&yes, "yes", false, "confirm deletion without prompting")
	}
	if err := fs.Parse(rest); err != nil {
		return fail(exitUsage, "%s", err)
	}
	if op == "delete" {
		if !yes || fs.NArg() != 0 {
			return fail(exitUsage, "usage: velvet comments (KEY | --project | --milestone UUID) delete ID --yes; deletion requires explicit --yes")
		}
	} else {
		if kind != "" && !kinds[kind] {
			return fail(exitUsage, "invalid --kind; use progress, decision, blocker, or note")
		}
		if parent != "" && !ticketUUID.MatchString(parent) {
			return fail(exitUsage, "--parent requires a comment UUID")
		}
		if len(images) > 0 && strings.HasPrefix(target, "/projects/") {
			return fail(exitUsage, "--image needs a ticket KEY or --milestone; project notes cannot hold images")
		}
		for _, img := range images {
			if err := checkImageFile(img.path); err != nil {
				return err
			}
		}
	}
	path := e.scoped(target + "/comments")
	method := http.MethodPost
	payload := map[string]string{}
	if op != "delete" {
		// Flags must precede the single body argument. This catches trailing flags instead of posting them as text.
		if fs.NArg() > 1 {
			return fail(exitUsage, "pass one quoted body argument, or provide the body on stdin; flags must precede the body")
		}
		body := ""
		if fs.NArg() == 1 {
			body = fs.Arg(0)
		} else if in != nil {
			raw, err := io.ReadAll(io.LimitReader(in, (64<<10)+1))
			if err != nil {
				return fail(exitUsage, "could not read comment body: %s", err)
			}
			if len(raw) > 64<<10 {
				return fail(exitUsage, "comment body exceeds 64 KiB")
			}
			body = string(raw)
		}
		if strings.TrimSpace(body) == "" {
			return fail(exitUsage, "comment body cannot be empty")
		}
		payload["body"] = body
		if kind != "" {
			payload["kind"] = kind
		}
		if parent != "" {
			payload["parent_id"] = parent
		}
	}
	if op != "add" {
		// Verify the selected target owns the comment before using the workspace-wide mutation endpoint.
		var thread struct {
			Comments []ticketComment `json:"comments"`
		}
		if err := e.api.Do(http.MethodGet, path, nil, nil, &thread); err != nil {
			return apiError(err)
		}
		if !ticketHasComment(thread.Comments, id) {
			return fail(exitNotFound, "comment %s is not in the selected target", id)
		}
		path = e.scoped("/comments/" + url.PathEscape(id))
		method = http.MethodPatch
		if op == "delete" {
			method = http.MethodDelete
		}
	}
	var body any = payload
	if op == "delete" {
		body = nil
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := e.api.Do(method, path, nil, body, &created); err != nil {
		return apiError(err)
	}
	for _, img := range images {
		var out struct {
			ID string `json:"id"`
		}
		if err := e.api.Upload(e.scoped(target+"/images"), img.path, img.caption, &out, map[string]string{"comment_id": created.ID}); err != nil {
			return fail(exitAPI, "comment %s posted, but %s did not upload: %s", created.ID, img.path, apiError(err))
		}
	}
	if len(images) > 0 {
		fmt.Fprintf(e.out, "Comment %s succeeded with %d image(s). Comment ID %s.\n", op, len(images), created.ID)
		return nil
	}
	fmt.Fprintf(e.out, "Comment %s succeeded.\n", op)
	return nil
}

type commentImage struct{ path, caption string }

// imageFlags collects repeated --image PATH#caption values. Without a caption
// the file name is used.
type imageFlags []commentImage

func (f *imageFlags) String() string { return "" }
func (f *imageFlags) Set(value string) error {
	path, caption, _ := strings.Cut(value, "#")
	if path == "" {
		return fmt.Errorf("--image needs a file path")
	}
	if strings.TrimSpace(caption) == "" {
		caption = filepath.Base(path)
	}
	*f = append(*f, commentImage{path, caption})
	return nil
}

type ticketComment struct {
	ID      string          `json:"id"`
	Replies []ticketComment `json:"replies"`
}

func ticketHasComment(comments []ticketComment, id string) bool {
	for _, comment := range comments {
		if strings.EqualFold(comment.ID, id) || ticketHasComment(comment.Replies, id) {
			return true
		}
	}
	return false
}
