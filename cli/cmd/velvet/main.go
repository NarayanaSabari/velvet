// Command velvet keeps a Velvet work log from a repository.
//
// `velvet init` links the repository to one organisation and one project and
// stores a key that the server limits to exactly that project. Every other
// command reads velvet.yaml from the repository and uses that key, so an agent
// running in the repository can reach that project and nothing else.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const defaultServer = "https://velvet.sabarinarayana.com"

// Exit codes are stable so scripts and agents can branch on them.
const (
	exitUsage    = 2
	exitAuth     = 3
	exitNotFound = 4
	exitNetwork  = 5
	exitAPI      = 6
	exitScope    = 7
	exitConfig   = 78
)

type exitError struct {
	code int
	msg  string
}

func (e exitError) Error() string { return e.msg }

func fail(code int, format string, args ...any) error {
	return exitError{code, fmt.Sprintf(format, args...)}
}

const usage = `Usage: velvet <command> [arguments]

Set up:
  login [--server URL] [--no-browser]      Sign in once through browser consent
  init [--organisation SLUG] [--project KEY]
                                          Link this directory in the terminal, without a browser
  whoami [--server URL] [--account ID]      Show the machine login identity
  logout [--server URL] [--account ID]      Revoke machine login and its project keys
  update [--check] [--server URL]         Install the latest CLI from the Velvet server

Work log:
  log [KEY] [--kind K] BODY               Log work on a ticket, or on the project without KEY
  attach KEY REFERENCE                    Attach a PR URL, owner/repo#N, or commit sha
  recap [--days N]                        Summarise recent work in this project

Tickets:
  issues [--status S] [--mine]            List this project's tickets
  issue KEY                               Show a ticket and its recent work log
  edit KEY [--title TEXT] [--desc TEXT] [--priority N] [--assignee ID|none] [--milestone ID|none]
                                          Edit fields without changing ticket status
  comments (KEY|--project|--milestone ID) (list|add|edit|delete) ...
                                          Read and manage comments, delete requires --yes
  evidence KEY list                       List linked evidence
  new TITLE [--desc D] [--milestone ID] [--priority N]
                                          File a ticket in this project
  status KEY STATUS                       Change a ticket's status (only when asked)
  key-from-branch                         Print the ticket key named by the current branch

Planning:
  sprints [new NAME FROM TO]              List or create this project's sprints
  milestones [SPRINT_ID | new SPRINT_ID NAME]
                                          List or create milestones
  sprint ID (show|edit|activate|complete) ...
                                          Manage a sprint; activation/completion require --yes
  milestone ID (show|edit) ...             Edit goals, status, ownership and ordering
  images (KEY|--milestone ID)              List target images
  image ID delete --yes                    Remove an image
  reports (activity|milestones|closed|stale) [flags]
                                          Read project-filtered reports
  mentions (list|read) [flags]             Read project mentions and mark them read
  admin (login|whoami|logout|RESOURCE ACTION) ...
                                          Separately approved account administration
  upload-image (KEY | --milestone ID) PATH --caption TEXT
                                          Attach an image without changing status

Run 'velvet <command> --help' for details. Version ` + "%s\n"

func main() {
	err := run(os.Args[1:], os.Stdout, os.Stderr, os.Stdin)
	if err == nil {
		return
	}
	var ee exitError
	if errors.As(err, &ee) {
		fmt.Fprintln(os.Stderr, "velvet: "+ee.msg)
		os.Exit(ee.code)
	}
	fmt.Fprintln(os.Stderr, "velvet: "+err.Error())
	os.Exit(1)
}

// env is everything a command needs once velvet.yaml and the key are loaded.
type env struct {
	repo   config.Repo
	api    *client.Client
	out    io.Writer
	errOut io.Writer
}

func (e env) scoped(path string) string {
	return "/w/" + url.PathEscape(e.repo.Organisation) + path
}

func loadEnv(out, errOut io.Writer) (env, error) {
	wd, err := os.Getwd()
	if err != nil {
		return env{}, err
	}
	repo, err := config.Find(wd)
	if err != nil {
		if errors.Is(err, config.ErrNotInitialised) {
			return env{}, fail(exitConfig, "%s", err)
		}
		return env{}, fail(exitConfig, "%s", err)
	}
	keys := config.Keys{}
	if err := keys.CheckBinding(wd, repo.Link); err != nil {
		return env{}, fail(exitConfig, "%s", err)
	}
	bound, err := keys.HasBinding(wd)
	if err != nil {
		return env{}, fail(exitConfig, "%s", err)
	}
	if !bound {
		if strings.TrimSpace(os.Getenv("VELVET_TOKEN")) == "" {
			return env{}, fail(exitConfig, "this directory has no private project binding; run velvet init to confirm this directory")
		}
		trusted, err := accountServer("")
		if err != nil {
			return env{}, err
		}
		if trusted != repo.ServerURL() {
			return env{}, fail(exitConfig, "unbound CI server differs from trusted VELVET_SERVER; set VELVET_SERVER explicitly or run velvet init")
		}
	}
	key, err := keys.Load(repo.Link)
	if err != nil {
		return env{}, fail(exitAuth, "%s", err)
	}
	api := client.New(repo.ServerURL(), key, version)
	if _, err := projectIdentity(api, repo.Link); err != nil {
		return env{}, err
	}
	return env{repo: repo, api: api, out: out, errOut: errOut}, nil
}

// apiError maps a server answer to an exit code and a message an agent can
// act on.
func apiError(err error) error {
	var ce *client.Error
	if !errors.As(err, &ce) {
		return fail(exitNetwork, "%s", err)
	}
	switch {
	case ce.Status == http.StatusUnauthorized:
		return fail(exitAuth, "this repository's key was revoked or is invalid; run velvet init")
	case ce.Code == "out_of_scope" || (ce.Status == http.StatusForbidden && strings.Contains(ce.Message, "project")):
		return fail(exitScope, "%s (this repository's key is limited to its own project)", ce.Message)
	case ce.Status == http.StatusNotFound:
		return fail(exitNotFound, "%s", ce.Message)
	case ce.Status == http.StatusForbidden:
		return fail(exitAuth, "%s", ce.Message)
	default:
		return fail(exitAPI, "%s", ce)
	}
}

// repoCommands need velvet.yaml and this repository's key.
var repoCommands = map[string]bool{
	"log": true, "attach": true, "recap": true,
	"edit": true, "comments": true, "evidence": true, "sprint": true, "milestone": true, "images": true, "image": true, "reports": true, "mentions": true,
	"issues": true, "issue": true, "new": true, "status": true, "sprints": true, "milestones": true, "upload-image": true,
}

func run(args []string, out, errOut io.Writer, in io.Reader) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintf(out, usage, version)
		return nil
	}
	if args[0] == "--version" || args[0] == "version" {
		fmt.Fprintln(out, "velvet "+version)
		return nil
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "admin":
		return cmdAdmin(rest, out, errOut, in)
	case "init":
		return cmdInit(rest, out, errOut, in)
	case "login":
		return cmdLogin(rest, out, errOut)
	case "whoami", "where", "me", "logout":
		return cmdIdentity(cmd, rest, out, errOut)
	case "key-from-branch":
		return cmdKeyFromBranch(out)
	case "update":
		return cmdUpdate(rest, out, errOut)
	}
	if !repoCommands[cmd] {
		return fail(exitUsage, "unknown command %q; run velvet --help", cmd)
	}
	e, err := loadEnv(out, errOut)
	if err != nil {
		return err
	}
	if handled, err := runTicketCommand(&e, cmd, rest, in); handled {
		return err
	}
	if handled, err := runPlanningCommand(&e, cmd, rest, in); handled {
		return err
	}
	if cmd == "reports" || cmd == "mentions" {
		return runProjectView(&e, cmd, rest)
	}
	switch cmd {
	case "log":
		return e.log(rest, in)
	case "attach":
		return e.attach(rest)
	case "recap":
		return e.recap(rest)
	case "issues":
		return e.issues(rest)
	case "issue":
		return e.issue(rest)
	case "new":
		return e.newIssue(rest)
	case "status":
		return e.status(rest)
	case "sprints":
		return e.sprints(rest)
	case "milestones":
		return e.milestones(rest)
	case "upload-image":
		return e.uploadImage(rest)
	default:
		return fail(exitUsage, "unknown command %q; run velvet --help", cmd)
	}
}

func openBrowser(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	_ = cmd.Start()
}

// ---- work log --------------------------------------------------------------

var kinds = map[string]bool{"progress": true, "decision": true, "blocker": true, "note": true}

func (e env) log(args []string, in io.Reader) error {
	key := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") && looksLikeKey(args[0]) {
		key, args = strings.ToUpper(args[0]), args[1:]
	}
	fs := flag.NewFlagSet("log", flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	kind := fs.String("kind", "", "progress, decision, blocker, or note")
	if err := fs.Parse(args); err != nil {
		return fail(exitUsage, "%s", err)
	}
	if *kind != "" && !kinds[*kind] {
		return fail(exitUsage, "invalid kind %q; use progress, decision, blocker, or note", *kind)
	}
	body := strings.Join(fs.Args(), " ")
	if body == "" {
		raw, err := io.ReadAll(io.LimitReader(in, 64<<10))
		if err != nil {
			return err
		}
		body = strings.TrimSpace(string(raw))
	}
	if body == "" {
		return fail(exitUsage, "the entry is empty; pass it as an argument or on stdin")
	}
	payload := map[string]string{"body": body}
	if *kind != "" {
		payload["kind"] = *kind
	}
	if key != "" {
		if err := e.api.Do(http.MethodPost, e.scoped("/issues/"+url.PathEscape(key)+"/comments"), nil, payload, nil); err != nil {
			return apiError(err)
		}
		fmt.Fprintf(e.out, "Logged to %s.\n", key)
		return nil
	}
	if err := e.api.Do(http.MethodPost, e.scoped("/projects/"+url.PathEscape(e.repo.Project)+"/comments"), nil, payload, nil); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "Logged to project %s.\n", e.repo.Project)
	return nil
}

var keyRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*-[0-9]+$`)

func looksLikeKey(s string) bool { return keyRe.MatchString(s) }

func (e env) attach(args []string) error {
	if len(args) != 2 {
		return fail(exitUsage, "usage: velvet attach KEY REFERENCE")
	}
	key := strings.ToUpper(args[0])
	if err := e.api.Do(http.MethodPost, e.scoped("/issues/"+url.PathEscape(key)+"/evidence"), nil, map[string]string{"reference": args[1]}, nil); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "Attached %s to %s as evidence. Status unchanged.\n", args[1], key)
	return nil
}

func (e env) recap(args []string) error {
	fs := flag.NewFlagSet("recap", flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	days := fs.Int("days", 7, "how many days back")
	if err := fs.Parse(args); err != nil {
		return fail(exitUsage, "%s", err)
	}
	if *days < 1 {
		return fail(exitUsage, "--days must be at least 1")
	}
	q := url.Values{"days": {fmt.Sprint(*days)}, "workspace": {e.repo.Organisation}, "project": {e.repo.Project}}
	text, err := e.api.Text("/me/worklog.md", q)
	if err != nil {
		return apiError(err)
	}
	fmt.Fprint(e.out, text)
	return nil
}

// ---- tickets ---------------------------------------------------------------

type issue struct {
	Key         string  `json:"key"`
	Title       string  `json:"title"`
	Status      string  `json:"status"`
	Priority    int     `json:"priority"`
	Description string  `json:"description"`
	AssigneeID  *string `json:"assignee_id"`
	MilestoneID *string `json:"milestone_id"`
}

var statuses = map[string]bool{"backlog": true, "todo": true, "in_progress": true, "in_review": true, "done": true, "cancelled": true}

func (e env) issues(args []string) error {
	fs := flag.NewFlagSet("issues", flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	status := fs.String("status", "", "only this status")
	mine := fs.Bool("mine", false, "only tickets assigned to you")
	if err := fs.Parse(args); err != nil {
		return fail(exitUsage, "%s", err)
	}
	q := url.Values{"limit": {"200"}}
	if *status != "" {
		if !statuses[*status] {
			return fail(exitUsage, "unknown status %q", *status)
		}
		q.Set("status", *status)
	}
	if *mine {
		var me struct {
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		if err := e.api.Do(http.MethodGet, "/me", nil, nil, &me); err != nil {
			return apiError(err)
		}
		q.Set("assignee_id", me.User.ID)
	}
	var list struct {
		Issues []issue `json:"issues"`
	}
	if err := e.api.Do(http.MethodGet, e.scoped("/issues"), q, nil, &list); err != nil {
		return apiError(err)
	}
	if len(list.Issues) == 0 {
		fmt.Fprintln(e.out, "No tickets found.")
		return nil
	}
	w := bufio.NewWriter(e.out)
	for _, i := range list.Issues {
		fmt.Fprintf(w, "%s\t%s\t%s\n", i.Key, i.Status, oneLine(i.Title))
	}
	return w.Flush()
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func (e env) issue(args []string) error {
	if len(args) != 1 {
		return fail(exitUsage, "usage: velvet issue KEY")
	}
	key := strings.ToUpper(args[0])
	var i issue
	if err := e.api.Do(http.MethodGet, e.scoped("/issues/"+url.PathEscape(key)), nil, nil, &i); err != nil {
		return apiError(err)
	}
	var thread struct {
		Comments []struct {
			Body      string `json:"body"`
			CreatedAt string `json:"created_at"`
			Kind      string `json:"kind"`
			Author    struct {
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"author"`
		} `json:"comments"`
	}
	if err := e.api.Do(http.MethodGet, e.scoped("/issues/"+url.PathEscape(key)+"/comments"), nil, nil, &thread); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "%s: %s\nStatus: %s\nPriority: %d\n", i.Key, i.Title, i.Status, i.Priority)
	if i.MilestoneID != nil {
		fmt.Fprintf(e.out, "Milestone: %s\n", *i.MilestoneID)
	}
	if d := strings.TrimSpace(i.Description); d != "" {
		fmt.Fprintf(e.out, "Description:\n%s\n", d)
	}
	recent := thread.Comments
	if len(recent) > 10 {
		recent = recent[len(recent)-10:]
	}
	fmt.Fprintln(e.out, "Recent work log:")
	if len(recent) == 0 {
		fmt.Fprintln(e.out, "  (none)")
	}
	for _, c := range recent {
		who := c.Author.Name
		if who == "" {
			who = c.Author.Email
		}
		day := c.CreatedAt
		if len(day) >= 10 {
			day = day[:10]
		}
		fmt.Fprintf(e.out, "  %s %s: %s\n", day, who, oneLine(c.Body))
	}
	return nil
}

func (e env) newIssue(args []string) error {
	title := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		title, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("new", flag.ContinueOnError)
	fs.SetOutput(e.errOut)
	desc := fs.String("desc", "", "description")
	milestone := fs.String("milestone", "", "milestone id")
	priority := fs.Int("priority", 0, "0 (none) to 4")
	if err := fs.Parse(args); err != nil {
		return fail(exitUsage, "%s", err)
	}
	if title == "" && fs.NArg() > 0 {
		title = strings.Join(fs.Args(), " ")
	}
	if strings.TrimSpace(title) == "" {
		return fail(exitUsage, "usage: velvet new TITLE [--desc D] [--milestone ID] [--priority N]")
	}
	payload := map[string]any{"title": title, "description": *desc, "priority": *priority}
	if *milestone != "" {
		payload["milestone_id"] = *milestone
	}
	var created issue
	if err := e.api.Do(http.MethodPost, e.scoped("/issues"), nil, payload, &created); err != nil {
		return apiError(err)
	}
	fmt.Fprintln(e.out, created.Key)
	return nil
}

func (e env) status(args []string) error {
	if len(args) != 2 {
		return fail(exitUsage, "usage: velvet status KEY STATUS")
	}
	key, status := strings.ToUpper(args[0]), args[1]
	if !statuses[status] {
		return fail(exitUsage, "status must be one of backlog, todo, in_progress, in_review, done, cancelled")
	}
	if err := e.api.Do(http.MethodPatch, e.scoped("/issues/"+url.PathEscape(key)), nil, map[string]string{"status": status}, nil); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "%s is now %s.\n", key, status)
	return nil
}

var branchKeyRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-[0-9]+)(?:$|[^A-Za-z0-9])`)

func cmdKeyFromBranch(out io.Writer) error {
	raw, err := exec.Command("git", "symbolic-ref", "--quiet", "--short", "HEAD").Output()
	if err != nil {
		return fail(1, "no ticket key: HEAD is detached or this is not a git repository")
	}
	branch := strings.TrimSpace(string(raw))
	m := branchKeyRe.FindStringSubmatch(branch)
	if m == nil {
		return fail(1, "no ticket key in branch %s", branch)
	}
	fmt.Fprintln(out, strings.ToUpper(m[1]))
	return nil
}

// ---- planning --------------------------------------------------------------

func (e env) sprints(args []string) error {
	if len(args) > 0 && args[0] == "new" {
		if len(args) != 4 {
			return fail(exitUsage, "usage: velvet sprints new NAME YYYY-MM-DD YYYY-MM-DD")
		}
		var sprint struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			State string `json:"state"`
		}
		payload := map[string]string{"name": args[1], "starts_on": args[2], "ends_on": args[3], "project": e.repo.Project}
		if err := e.api.Do(http.MethodPost, e.scoped("/sprints"), nil, payload, &sprint); err != nil {
			return apiError(err)
		}
		fmt.Fprintf(e.out, "%s\t%s\t%s\n", sprint.ID, sprint.Name, sprint.State)
		return nil
	}
	var list struct {
		Sprints []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			StartsOn string `json:"starts_on"`
			EndsOn   string `json:"ends_on"`
			State    string `json:"state"`
		} `json:"sprints"`
	}
	if err := e.api.Do(http.MethodGet, e.scoped("/sprints"), url.Values{"project": {e.repo.Project}}, nil, &list); err != nil {
		return apiError(err)
	}
	if len(list.Sprints) == 0 {
		fmt.Fprintln(e.out, "No sprints yet. Create one with: velvet sprints new NAME FROM TO")
	}
	for _, s := range list.Sprints {
		fmt.Fprintf(e.out, "%s\t%s\t%s to %s\t%s\n", s.ID, s.Name, s.StartsOn, s.EndsOn, s.State)
	}
	return nil
}

func (e env) milestones(args []string) error {
	if len(args) > 0 && args[0] == "new" {
		if len(args) != 3 {
			return fail(exitUsage, "usage: velvet milestones new SPRINT_ID NAME")
		}
		var m struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := e.api.Do(http.MethodPost, e.scoped("/sprints/"+url.PathEscape(args[1])+"/milestones"), nil, map[string]string{"name": args[2]}, &m); err != nil {
			return apiError(err)
		}
		fmt.Fprintf(e.out, "%s\t%s\n", m.ID, m.Name)
		return nil
	}
	path := e.scoped("/milestones")
	if len(args) == 1 {
		path = e.scoped("/sprints/" + url.PathEscape(args[0]) + "/milestones")
	}
	var list struct {
		Milestones []struct {
			ID       string `json:"id"`
			SprintID string `json:"sprint_id"`
			Name     string `json:"name"`
			Status   string `json:"status"`
		} `json:"milestones"`
	}
	if err := e.api.Do(http.MethodGet, path, nil, nil, &list); err != nil {
		return apiError(err)
	}
	if len(list.Milestones) == 0 {
		fmt.Fprintln(e.out, "No milestones.")
	}
	for _, m := range list.Milestones {
		fmt.Fprintf(e.out, "%s\t%s\t%s\tsprint %s\n", m.ID, m.Name, m.Status, m.SprintID)
	}
	return nil
}

func (e env) uploadImage(args []string) error {
	key, milestone, path, caption := "", "", "", ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--milestone":
			if i+1 >= len(args) {
				return fail(exitUsage, "--milestone needs an id")
			}
			milestone, i = args[i+1], i+1
		case "--caption":
			if i+1 >= len(args) {
				return fail(exitUsage, "--caption needs text")
			}
			caption, i = args[i+1], i+1
		default:
			if key == "" && milestone == "" && looksLikeKey(args[i]) {
				key = strings.ToUpper(args[i])
			} else if path == "" {
				path = args[i]
			} else {
				return fail(exitUsage, "unexpected argument %q", args[i])
			}
		}
	}
	if (key == "") == (milestone == "") || path == "" || strings.TrimSpace(caption) == "" {
		return fail(exitUsage, "usage: velvet upload-image (KEY | --milestone ID) PATH --caption TEXT")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fail(exitUsage, "%s", err)
	}
	if !info.Mode().IsRegular() {
		return fail(exitUsage, "%s is not a regular file", path)
	}
	if info.Size() == 0 || info.Size() > 10<<20 {
		return fail(exitUsage, "images must be between 1 byte and 10 MiB")
	}
	target := e.scoped("/issues/" + url.PathEscape(key) + "/images")
	if milestone != "" {
		target = e.scoped("/milestones/" + url.PathEscape(milestone) + "/images")
	}
	var image struct {
		ID string `json:"id"`
	}
	if err := e.api.Upload(target, path, caption, &image); err != nil {
		return apiError(err)
	}
	fmt.Fprintf(e.out, "Uploaded image %s. Status unchanged.\n", image.ID)
	return nil
}
