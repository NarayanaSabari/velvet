package main

import (
	"encoding/json"
	"net/url"
)

// Project views share request validation with management views, but never load
// management credentials. The API independently pins results to the token scope.
func runProjectView(e *env, command string, args []string) error {
	if len(args) == 0 && command == "mentions" {
		args = []string{"list"}
	}
	o, err := parseAdminOptions(append([]string{command}, args...))
	if err != nil {
		return err
	}
	for _, selector := range []string{"server", "account", "organisation"} {
		if _, exists := o.values[selector]; exists {
			return fail(exitUsage, "project views use this directory's binding; --%s is not allowed", selector)
		}
	}
	r, err := buildAdminRequest(o)
	if err != nil {
		return err
	}
	if r.query == nil {
		r.query = url.Values{}
	}
	r.query.Set("project", e.repo.Project)
	var result any
	if err := e.api.Do(r.method, e.scoped(r.path), r.query, r.body, &result); err != nil {
		return apiError(err)
	}
	if result == nil {
		result = map[string]bool{"ok": true}
	}
	encoder := json.NewEncoder(e.out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}
