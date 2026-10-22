package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Milestone descriptions hold narrative goals. Ordering uses existing sibling
// milestones through --after/--before, not unsupported sprint reassignment.
const planningUsage = `Planning:
  sprint ID show
  sprint ID edit [--name NAME] [--starts-on YYYY-MM-DD] [--ends-on YYYY-MM-DD]
  sprint ID activate --yes   Completes the previous active sprint
  sprint ID complete --yes  Closes the sprint
  milestone ID show
  milestone ID edit [--name NAME] [--description TEXT] [--owner UUID|none] [--status STATUS] [--target-date YYYY-MM-DD|""] [--after ID] [--before ID] [--yes]
  sprints edit ID [flags]    Alias for sprint ID edit
  milestones edit ID [flags] Alias for milestone ID edit
  images KEY
  images --milestone ID
  image ID delete --yes
`

var planningUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func planningID(id string) bool {
	return planningUUID.MatchString(id) && strings.ReplaceAll(id, "-", "") != strings.Repeat("0", 32)
}

// planningFlags rejects unknown, duplicate and positional arguments, including
// arguments after flags. Empty values remain explicit for fields such as dates.
func planningFlags(args []string, allowed string) (map[string]string, error) {
	values := map[string]string{}
	for i := 0; i < len(args); i++ {
		name, value, assigned := strings.Cut(args[i], "=")
		if !strings.HasPrefix(name, "--") || !strings.Contains(" "+allowed+" ", " "+name+" ") {
			return nil, fail(exitUsage, "unknown argument %q", args[i])
		}
		if _, exists := values[name]; exists {
			return nil, fail(exitUsage, "duplicate flag %s", name)
		}
		if name == "--yes" {
			if assigned {
				return nil, fail(exitUsage, "use --yes without a value")
			}
			value = "true"
		} else if !assigned {
			i++
			if i == len(args) || strings.HasPrefix(args[i], "--") {
				return nil, fail(exitUsage, "%s requires a value", name)
			}
			value = args[i]
		}
		values[name] = value
	}
	return values, nil
}

// runPlanningCommand handles new planning verbs only. Returning false leaves
// existing plural list/new commands to their original handlers. Authentication
// and project-scope verification remain the dispatcher's loadEnv responsibility.
func runPlanningCommand(e *env, cmd string, args []string, _ io.Reader) (bool, error) {
	if (cmd == "sprints" || cmd == "milestones") && len(args) > 0 && args[0] == "edit" {
		if len(args) < 2 {
			return true, fail(exitUsage, "edit requires a UUID")
		}
		cmd = strings.TrimSuffix(cmd, "s")
		args = append([]string{args[1], "edit"}, args[2:]...)
	}
	if cmd != "sprint" && cmd != "milestone" && cmd != "images" && cmd != "image" {
		return false, nil
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprint(e.out, planningUsage)
		return true, err
	}
	method, path := http.MethodGet, ""
	var payload any
	if cmd == "images" {
		switch {
		case len(args) == 1 && looksLikeKey(args[0]):
			path = "/issues/" + strings.ToUpper(args[0]) + "/images"
		case len(args) == 2 && args[0] == "--milestone" && planningID(args[1]):
			path = "/milestones/" + args[1] + "/images"
		default:
			return true, fail(exitUsage, "usage: velvet images KEY | --milestone ID")
		}
	} else {
		if len(args) < 2 || !planningID(args[0]) {
			return true, fail(exitUsage, "%s requires a UUID and action; run velvet %s --help", cmd, cmd)
		}
		id, action := args[0], args[1]
		path = "/" + cmd + "s/" + id
		allowed := ""
		switch action {
		case "show":
			if cmd == "image" {
				return true, fail(exitUsage, "image only supports delete")
			}
		case "activate", "complete":
			if cmd != "sprint" {
				return true, fail(exitUsage, "%s only supports show/edit", cmd)
			}
			allowed = "--yes"
		case "delete":
			if cmd != "image" {
				return true, fail(exitUsage, "delete only supports images")
			}
			allowed = "--yes"
		case "edit":
			switch cmd {
			case "sprint":
				allowed = "--name --starts-on --ends-on"
			case "milestone":
				allowed = "--name --description --owner --status --target-date --after --before --yes"
			default:
				return true, fail(exitUsage, "image only supports delete")
			}
		default:
			return true, fail(exitUsage, "unknown %s action %q", cmd, action)
		}
		flags, err := planningFlags(args[2:], allowed)
		if err != nil {
			return true, err
		}
		if action == "activate" || action == "complete" || action == "delete" {
			if flags["--yes"] != "true" {
				return true, fail(exitUsage, "%s requires explicit --yes; activation completes the previous active sprint", action)
			}
			method = http.MethodPost
			if action == "delete" {
				method = http.MethodDelete
			} else if action == "complete" {
				path += "/close"
			} else {
				path += "/activate"
			}
		}
		if action == "edit" {
			patch := map[string]string{}
			for key, value := range flags {
				if key == "--yes" {
					continue
				}
				field := strings.ReplaceAll(strings.TrimPrefix(key, "--"), "-", "_")
				if key == "--after" || key == "--before" {
					if !planningID(value) || strings.EqualFold(value, id) {
						return true, fail(exitUsage, "%s requires another resource UUID", key)
					}
					field += "_id"
				}
				if key == "--owner" {
					field = "owner_id"
					if value == "none" {
						value = ""
					} else if !planningID(value) {
						return true, fail(exitUsage, "--owner requires a UUID or none")
					}
				}
				if key == "--name" && strings.TrimSpace(value) == "" {
					return true, fail(exitUsage, "name cannot be empty")
				}
				if key == "--starts-on" || key == "--ends-on" || (key == "--target-date" && value != "") {
					parsed, err := time.Parse("2006-01-02", value)
					if err != nil || parsed.Format("2006-01-02") != value {
						return true, fail(exitUsage, "%s must be YYYY-MM-DD", key)
					}
				}
				if key == "--status" {
					if value != "planned" && value != "in_progress" && value != "completed" && value != "cancelled" {
						return true, fail(exitUsage, "invalid milestone status %q", value)
					}
					if (value == "completed" || value == "cancelled") && flags["--yes"] != "true" {
						return true, fail(exitUsage, "%s requires explicit --yes", value)
					}
				}
				patch[field] = value
			}
			if len(patch) == 0 {
				return true, fail(exitUsage, "edit requires at least one field")
			}
			if patch["starts_on"] != "" && patch["ends_on"] != "" && patch["ends_on"] < patch["starts_on"] {
				return true, fail(exitUsage, "ends_on must not precede starts_on")
			}
			if patch["after_id"] != "" && strings.EqualFold(patch["after_id"], patch["before_id"]) {
				return true, fail(exitUsage, "--after and --before must differ")
			}
			method, payload = http.MethodPatch, patch
		}
	}
	var result json.RawMessage
	if err := e.api.Do(method, e.scoped(path), nil, payload, &result); err != nil {
		return true, apiError(err)
	}
	if method == http.MethodDelete {
		_, err := fmt.Fprintln(e.out, "Image deleted. Status unchanged.")
		return true, err
	}
	if len(result) == 0 {
		return true, nil
	}
	// Encode through RawMessage to preserve the API's complete metadata.
	encoder := json.NewEncoder(e.out)
	encoder.SetIndent("", "  ")
	return true, encoder.Encode(result)
}
