package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

func TestAdminRequestContracts(t *testing.T) {
	cases := []struct{ command, method, path, query, body string }{
		{"members list", "GET", "/memberships", "", ""},
		{"members set-role membership viewer --yes", "PATCH", "/memberships/membership", "", `{"role":"viewer"}`},
		{"members remove membership --yes", "DELETE", "/memberships/membership", "", ""},
		{"invites list", "GET", "/invites", "", ""},
		{"invites create alice@example.com member", "POST", "/invites", "", `{"email":"alice@example.com","role":"member"}`},
		{"invites resend invite", "POST", "/invites/invite/resend", "", ""},
		{"invites revoke invite --yes", "DELETE", "/invites/invite", "", ""},
		{"organisation update --name Lab", "PATCH", "", "", `{"name":"Lab"}`},
		{"organisation delete --yes", "DELETE", "", "", `{"confirm":"lab"}`},
		{"organisation leave --yes", "POST", "/leave", "", ""},
		{"projects list --include-archived", "GET", "/projects", "include_archived=true", ""},
		{"projects show web", "GET", "/projects/web", "", ""},
		{"projects create web --name Web --description Desc", "POST", "/projects", "", `{"key":"web","name":"Web","description":"Desc"}`},
		{"projects update web --description=", "PATCH", "/projects/web", "", `{"description":""}`},
		{"projects update web --status active", "PATCH", "/projects/web", "", `{"status":"active"}`},
		{"projects archive web --yes", "PATCH", "/projects/web", "", `{"status":"archived"}`},
		{"github status", "GET", "/github", "", ""},
		{"github repositories", "GET", "/repos", "", ""},
		{"github identity", "GET", "/me/github", "", ""},
		{"github unlink --yes", "DELETE", "/me/github", "", ""},
		{"github sync", "POST", "/github/sync", "", ""},
		{"github map-repository repo --project-id project", "PUT", "/repos/repo/project", "", `{"project_id":"project"}`},
		{"github unmap-repository repo --yes", "PUT", "/repos/repo/project", "", `{"project_id":null}`},
		{"reports activity --from 2026-10-01 --to 2026-10-22", "GET", "/reports/activity", "from=2026-10-01&to=2026-10-22", ""},
		{"reports milestones", "GET", "/reports/milestones", "", ""},
		{"reports closed", "GET", "/reports/closed", "", ""},
		{"reports stale --days 30", "GET", "/reports/stale", "days=30", ""},
		{"mentions list --unread", "GET", "/mentions", "unread=true", ""},
		{"mentions read c1 c2", "POST", "/mentions/read", "", `{"comment_ids":["c1","c2"]}`},
		{"mentions read --all --yes", "POST", "/mentions/read", "", `{"comment_ids":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			o, err := parseAdminOptions(append(strings.Fields(tc.command), "--organisation", "lab"))
			if err != nil {
				t.Fatal(err)
			}
			request, err := buildAdminRequest(o)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != tc.method || r.URL.Path != "/api/v1/w/lab"+tc.path || r.URL.RawQuery != tc.query {
					t.Errorf("request=%s %s, want %s %s?%s", r.Method, r.URL, tc.method, tc.path, tc.query)
				}
				if r.Header.Get("Authorization") != "Bearer management-only" {
					t.Errorf("wrong credential: %s", r.Header.Get("Authorization"))
				}
				raw, _ := io.ReadAll(r.Body)
				if tc.body == "" {
					if len(raw) > 0 {
						t.Errorf("unexpected body %s", raw)
					}
				} else {
					var got, want any
					if err := json.Unmarshal(raw, &got); err != nil {
						t.Error(err)
					}
					_ = json.Unmarshal([]byte(tc.body), &want)
					if !reflect.DeepEqual(got, want) {
						t.Errorf("body=%s, want %s", raw, tc.body)
					}
				}
				if tc.path == "/github/sync" {
					w.WriteHeader(http.StatusAccepted)
					io.WriteString(w, `{"status":"syncing"}`)
				} else if tc.method == "DELETE" || tc.method == "PUT" {
					w.WriteHeader(http.StatusNoContent)
				} else {
					io.WriteString(w, `{"contract":"ok"}`)
				}
			}))
			defer server.Close()
			var out bytes.Buffer
			e := &env{api: client.New(server.URL, "management-only", version), out: &out, errOut: io.Discard}
			if err := executeAdminRequest(e, o, request); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || !json.Valid(out.Bytes()) {
				t.Fatalf("calls=%d output=%s", calls, out.String())
			}
		})
	}
}

func TestAdminRejectsUnsafeOrIgnoredArgumentsBeforeCredentials(t *testing.T) {
	isolatedCLI(t)
	cases := []string{
		"members set-role member admin", "members remove member", "invites revoke invite", "organisation delete", "organisation leave", "projects archive web", "projects update web --status archived", "github unlink", "github unmap-repository repo", "mentions read --all",
		"members set-role member owner --yes", "projects update web", "projects update web --status done", "projects create web", "reports stale --days 0", "reports stale --days 366", "reports activity --from 2026-02-30", "mentions read", "mentions read c1 --all --yes", "members list extra", "members list --project-id other", "reports activity --organisation other", "projects create web --name=", "projects list --unread", "github sync --yes", "members list --server https://other.example", "members list --yes=false", "members list --typo x",
	}
	for _, command := range cases {
		t.Run(command, func(t *testing.T) {
			args := append(strings.Fields(command), "--server", "https://explicit.example", "--account", "alice", "--organisation", "lab")
			err := runAdminCommand(args, io.Discard, io.Discard, strings.NewReader(""))
			requireExit(t, err, exitUsage, "")
		})
	}
}

func TestAdminRequiresExplicitSelectors(t *testing.T) {
	isolatedCLI(t)
	for _, missing := range []string{"server", "account", "organisation"} {
		args := []string{"members", "list"}
		for _, key := range []string{"server", "account", "organisation"} {
			if key != missing {
				args = append(args, "--"+key, "explicit")
			}
		}
		err := runAdminCommand(args, io.Discard, io.Discard, nil)
		requireExit(t, err, exitUsage, "explicit --"+missing)
	}
}

func TestAdminDoesNotUseYAMLSetupOrEnvironmentCredential(t *testing.T) {
	dir := isolatedCLI(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		t.Errorf("unexpected request using %q", r.Header.Get("Authorization"))
	}))
	defer server.Close()
	t.Setenv("VELVET_TOKEN", "must-not-use-environment")
	keys := config.Keys{}
	if _, err := keys.SaveLogin(server.URL, "alice", "must-not-use-setup"); err != nil {
		t.Fatal(err)
	}
	link := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
	if _, err := keys.Save(link, "must-not-use-project"); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Write(dir, link); err != nil {
		t.Fatal(err)
	}
	err := runAdminCommand([]string{"members", "list", "--server", server.URL, "--account", "alice", "--organisation", "lab"}, io.Discard, io.Discard, nil)
	if err == nil {
		t.Fatal("management operation accepted without separate consent")
	}
	if calls != 0 {
		t.Fatalf("%d requests without management credential", calls)
	}
}

func TestAdminUsesExplicitManagementAccountAndServer(t *testing.T) {
	dir := isolatedCLI(t)
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer consented-alice" {
			t.Errorf("wrong credential: %s", r.Header.Get("Authorization"))
		}
		if r.URL.Path == "/api/v1/me" {
			fmt.Fprint(w, `{"token_kind":"personal","user":{"id":"alice"},"memberships":[{"workspace_slug":"lab","role":"admin"}]}`)
			return
		}
		if r.URL.Path != "/api/v1/w/lab/memberships" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		fmt.Fprint(w, `{"memberships":[]}`)
	}))
	defer server.Close()
	keys := config.Keys{}
	for _, tc := range []struct{ user, token string }{{"alice", "consented-alice"}, {"bob", "other-management"}} {
		if _, err := keys.SaveManagement(server.URL, tc.user, tc.token); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup-only"); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Write(dir, config.Link{Server: "https://untrusted.example", Organisation: "other", Project: "other"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VELVET_TOKEN", "environment-only")
	var out bytes.Buffer
	err := runAdminCommand([]string{"--server", server.URL, "members", "list", "--account", "alice", "--organisation", "lab"}, &out, io.Discard, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || !strings.Contains(out.String(), `"memberships": []`) {
		t.Fatalf("requests=%v output=%s", requests, out.String())
	}
}

func TestAdminBrowserStartsNeverForgeOAuth(t *testing.T) {
	for _, action := range []string{"connect", "link"} {
		t.Run(action, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
			defer server.Close()
			o, err := parseAdminOptions([]string{"github", action, "--organisation", "lab"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := buildAdminRequest(o)
			if err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			e := &env{api: client.New(server.URL, "secret", version), out: &out}
			if err := executeAdminRequest(e, o, r); err != nil {
				t.Fatal(err)
			}
			if calls != 0 || !strings.Contains(out.String(), server.URL+"/api/v1/w/lab/") || !strings.Contains(out.String(), "browser") || strings.Contains(out.String(), "secret") || strings.Contains(out.String(), "state=") {
				t.Fatalf("calls=%d output=%s", calls, out.String())
			}
		})
	}
}

func TestAdminOrganisationShowFiltersMembership(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/me" {
			t.Errorf("path %s", r.URL.Path)
		}
		fmt.Fprint(w, `{"memberships":[{"workspace_slug":"other","workspace_name":"Private"},{"workspace_slug":"lab","workspace_name":"Lab"}]}`)
	}))
	defer server.Close()
	o, _ := parseAdminOptions([]string{"organisation", "show", "--organisation", "lab"})
	r, _ := buildAdminRequest(o)
	var out bytes.Buffer
	e := &env{api: client.New(server.URL, "personal", version), out: &out}
	if err := executeAdminRequest(e, o, r); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Private") || !strings.Contains(out.String(), `"workspace_name": "Lab"`) {
		t.Fatal(out.String())
	}
	o.values["organisation"] = "missing"
	requireExit(t, executeAdminRequest(e, o, r), exitNotFound, "no membership")
}

func TestAdminUnauthorizedUsesManagementRecovery(t *testing.T) {
	err := managementRequestError(&client.Error{Status: http.StatusUnauthorized, Message: "revoked"})
	requireExit(t, err, exitAuth, "velvet admin login")
	if strings.Contains(err.Error(), "velvet init") {
		t.Fatal(err)
	}
}
