package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

func TestProjectViewsPinScopeAndDoNotUseManagement(t *testing.T) {
	for _, tc := range []struct {
		command      string
		args         []string
		path, method string
	}{
		{"reports", []string{"activity", "--from", "2026-10-01"}, "/reports/activity", "GET"},
		{"reports", []string{"milestones"}, "/reports/milestones", "GET"},
		{"reports", []string{"closed"}, "/reports/closed", "GET"},
		{"reports", []string{"stale", "--days", "7"}, "/reports/stale", "GET"},
		{"mentions", nil, "/mentions", "GET"},
		{"mentions", []string{"read", "--all", "--yes"}, "/mentions/read", "POST"},
	} {
		t.Run(tc.command+tc.path, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != tc.method || r.URL.Path != "/api/v1/w/lab"+tc.path || r.URL.Query().Get("project") != "web" || r.Header.Get("Authorization") != "Bearer project-secret" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.String())
				}
				io.WriteString(w, `{"ok":true}`)
			}))
			defer server.Close()
			var out bytes.Buffer
			e := env{repo: config.Repo{Link: config.Link{Organisation: "lab", Project: "web"}}, api: client.New(server.URL, "project-secret", "test"), out: &out, errOut: io.Discard}
			if err := runProjectView(&e, tc.command, tc.args); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("calls=%d", calls)
			}
			if err := runProjectView(&e, tc.command, append(tc.args, "--organisation", "other")); err == nil {
				t.Fatal("scope override accepted")
			}
			if calls != 1 {
				t.Fatal("scope override reached server")
			}
		})
	}
}
