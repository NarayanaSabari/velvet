package api

import (
	"net/http"
	"strings"
)

// pathIssueKey normalizes the issue key at the HTTP boundary. Issue keys are
// stored uppercase, so every route can keep using the indexed exact lookup.
func pathIssueKey(r *http.Request) string {
	return strings.ToUpper(strings.TrimSpace(r.PathValue("key")))
}
