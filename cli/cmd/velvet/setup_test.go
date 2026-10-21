package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

func isolatedCLI(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("APPDATA", home)
	t.Setenv("VELVET_NO_KEYCHAIN", "1")
	t.Setenv("VELVET_TOKEN", "")
	t.Setenv("VELVET_SERVER", "")
	dir := t.TempDir()
	t.Chdir(dir)
	return dir
}

func runCLI(t *testing.T, input string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(args, &out, &out, strings.NewReader(input))
	return out.String(), err
}

func requireExit(t *testing.T, err error, code int, text string) {
	t.Helper()
	var ee exitError
	if !errors.As(err, &ee) || ee.code != code || !strings.Contains(err.Error(), text) {
		t.Fatalf("error=%v, want exit %d containing %q", err, code, text)
	}
}

func projectMe(w http.ResponseWriter, user, project string) {
	fmt.Fprintf(w, `{"token_kind":"project","user":{"id":%q,"name":"Alice"},"scope":{"workspace_slug":"lab","project_key":%q}}`, user, project)
}

func setupMe(w http.ResponseWriter) {
	io.WriteString(w, `{"token_kind":"setup","user":{"id":"alice","name":"Alice"},"memberships":[{"workspace_slug":"viewers","workspace_name":"View only","role":"viewer"},{"workspace_slug":"lab","workspace_name":"Lab","role":"admin"}]}`)
}

func TestUnboundStoredKeyAndTamperedBoundYAMLNeverReachServer(t *testing.T) {
	dir := isolatedCLI(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; projectMe(w, "alice", "other") }))
	defer server.Close()
	keys := config.Keys{}
	a := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
	b := a
	b.Project = "other"
	if _, err := keys.Save(b, "cached-other"); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Write(dir, b); err != nil {
		t.Fatal(err)
	}
	_, err := runCLI(t, "", "issues")
	requireExit(t, err, exitConfig, "no private project binding")
	if calls != 0 {
		t.Fatalf("unbound YAML selected cached key: %d calls", calls)
	}
	if err := keys.Bind(dir, a); err != nil {
		t.Fatal(err)
	}
	_, err = runCLI(t, "", "issues")
	requireExit(t, err, exitConfig, "private directory binding differs")
	if calls != 0 {
		t.Fatalf("edited YAML selected cached key: %d calls", calls)
	}
	_, err = runCLI(t, "", "init", "--non-interactive")
	requireExit(t, err, exitConfig, "--relink")
	if calls != 0 {
		t.Fatalf("init sent setup credential before relink consent: %d calls", calls)
	}
	_, err = runCLI(t, "", "init", "--relink", "--non-interactive")
	requireExit(t, err, exitUsage, "required in noninteractive mode")
	if calls != 0 {
		t.Fatal("unconfirmed relink reached server")
	}
	if _, err := runCLI(t, "", "init", "--relink", "--yes", "--non-interactive"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("confirmed relink did not reuse scoped key: %d", calls)
	}
	if err := keys.CheckBinding(dir, b); err != nil {
		t.Fatal(err)
	}
}

func TestCIOriginPinAndTokenKindScopeVerification(t *testing.T) {
	for _, kind := range []string{"project", "setup", "personal", "wrong-scope"} {
		t.Run(kind, func(t *testing.T) {
			dir := isolatedCLI(t)
			meCalls, workCalls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/me" {
					meCalls++
					if kind == "project" {
						projectMe(w, "alice", "web")
					} else if kind == "wrong-scope" {
						projectMe(w, "alice", "other")
					} else {
						fmt.Fprintf(w, `{"token_kind":%q,"user":{"id":"alice"}}`, kind)
					}
					return
				}
				workCalls++
				io.WriteString(w, `{"issues":[]}`)
			}))
			defer server.Close()
			link := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
			if _, err := config.Write(dir, link); err != nil {
				t.Fatal(err)
			}
			t.Setenv("VELVET_TOKEN", "env-secret")
			t.Setenv("VELVET_SERVER", "https://trusted.example")
			_, err := runCLI(t, "", "issues")
			requireExit(t, err, exitConfig, "trusted VELVET_SERVER")
			if meCalls+workCalls != 0 {
				t.Fatal("sent CI token to YAML-selected origin")
			}
			t.Setenv("VELVET_SERVER", server.URL)
			_, err = runCLI(t, "", "issues")
			if kind == "project" {
				if err != nil || workCalls != 1 {
					t.Fatalf("pinned scoped CI: %v, work calls %d", err, workCalls)
				}
			} else {
				requireExit(t, err, exitScope, "")
				if workCalls != 0 {
					t.Fatal("unscoped or mismatched token reached work endpoint")
				}
			}
			if meCalls != 1 {
				t.Fatalf("/me calls=%d", meCalls)
			}
		})
	}
}

func TestInitMissingLoginNeverStartsBrowserFlow(t *testing.T) {
	dir := isolatedCLI(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }))
	defer server.Close()
	_, err := runCLI(t, "", "init", "--server", server.URL, "--organisation", "lab", "--project", "web", "--non-interactive")
	requireExit(t, err, exitAuth, "velvet login")
	if calls != 0 {
		t.Fatal("init attempted browser or network without login")
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed init wrote YAML")
	}
}

func TestInitMigratesLegacyKeyInInvocationDirectoryAndReusesIt(t *testing.T) {
	root := isolatedCLI(t)
	if out, err := exec.Command("git", "init", "--quiet", root).CombinedOutput(); err != nil {
		t.Fatalf("git init: %s %v", out, err)
	}
	dir := filepath.Join(root, "nested")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/me" || r.Header.Get("Authorization") != "Bearer legacy-project" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		projectMe(w, "alice", "web")
	}))
	defer server.Close()
	link := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
	if _, err := (config.Keys{}).Save(link, "legacy-project"); err != nil {
		t.Fatal(err)
	}
	args := []string{"init", "--server", server.URL, "--organisation", "lab", "--project", "web", "--non-interactive"}
	for range 2 {
		out, err := runCLI(t, "", args...)
		if err != nil || !strings.Contains(out, "Reused the valid project key") {
			t.Fatalf("init=%s %v", out, err)
		}
	}
	if requests != 2 {
		t.Fatalf("repeat init minted or polled instead of reusing: %d", requests)
	}
	if _, err := os.Stat(filepath.Join(root, config.FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("init wrote at git root")
	}
	repo, err := config.Find(dir)
	if err != nil || !config.SameLink(repo.Link, link) || repo.Path != filepath.Join(dir, config.FileName) {
		t.Fatalf("repo=%+v %v", repo, err)
	}
	if ok, err := (config.Keys{}).HasBinding(dir); err != nil || !ok {
		t.Fatalf("no private binding: %v", err)
	}
}

func TestInitNewProjectUsesSetupOnlyForIssuanceThenScopedKey(t *testing.T) {
	dir := isolatedCLI(t)
	issuance, work := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/v1/me":
			if token == "Bearer setup" {
				setupMe(w)
			} else if token == "Bearer scoped" {
				projectMe(w, "alice", "web")
			} else {
				t.Errorf("unknown token %s", token)
				w.WriteHeader(401)
			}
		case "/api/v1/cli/project-tokens":
			issuance++
			if token != "Bearer setup" {
				t.Error("issuance did not use setup")
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["workspace_slug"] != "lab" || body["project_key"] != "web" {
				t.Errorf("issuance body %+v %v", body, err)
			}
			io.WriteString(w, `{"token":"scoped","kind":"project","workspace_slug":"lab","project_key":"web"}`)
		case "/api/v1/w/lab/issues":
			work++
			if token != "Bearer scoped" {
				t.Error("setup credential reached work")
			}
			io.WriteString(w, `{"issues":[]}`)
		default:
			t.Errorf("unexpected browser/data call: %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	keys := config.Keys{}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	out, err := runCLI(t, "", "init", "--server", server.URL, "--organisation", "lab", "--project", "web", "--non-interactive")
	if err != nil {
		t.Fatalf("%s %v", out, err)
	}
	if issuance != 1 {
		t.Fatalf("issuance=%d", issuance)
	}
	if _, err := runCLI(t, "", "issues"); err != nil {
		t.Fatal(err)
	}
	if work != 1 {
		t.Fatal("scoped work request missing")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, config.FileName))
	if bytes.Contains(raw, []byte("scoped")) || bytes.Contains(raw, []byte("setup")) {
		t.Fatal("secret in YAML")
	}
	if _, err := runCLI(t, "", "init", "--non-interactive"); err != nil {
		t.Fatal(err)
	}
	if issuance != 1 {
		t.Fatal("repeat init rotated valid key")
	}
}

func TestInitRejectsCachedAccountMismatchBeforeIssuance(t *testing.T) {
	isolatedCLI(t)
	issued := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/me" {
			projectMe(w, "bob", "web")
			return
		}
		issued++
		w.WriteHeader(500)
	}))
	defer server.Close()
	keys := config.Keys{}
	link := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
	if _, err := keys.Save(link, "bobs-project"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	_, err := runCLI(t, "", "init", "--server", server.URL, "--organisation", "lab", "--project", "web", "--non-interactive")
	requireExit(t, err, exitAuth, "belongs to another account")
	if issued != 0 {
		t.Fatal("account mismatch silently replaced credential")
	}
}

func TestLoginDeviceFlowAndRepeatReuseOutsideRepository(t *testing.T) {
	dir := isolatedCLI(t)
	starts, polls := 0, 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/cli/sessions":
			starts++
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["flow"] != "login" {
				t.Errorf("login flow %+v %v", body, err)
			}
			json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "ABCD-EFGH", "verification_uri_complete": server.URL + "/cli/authorize?code=ABCD-EFGH", "expires_at": time.Now().Add(time.Minute), "interval": 1})
		case "/api/v1/cli/sessions/token":
			polls++
			io.WriteString(w, `{"token":"setup","kind":"setup"}`)
		case "/api/v1/me":
			setupMe(w)
		default:
			t.Errorf("unexpected login request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	for range 2 {
		out, err := runCLI(t, "", "login", "--server", server.URL, "--no-browser")
		if err != nil {
			t.Fatalf("login: %s %v", out, err)
		}
	}
	if starts != 1 || polls != 1 {
		t.Fatalf("repeated login created orphan setup token: starts=%d polls=%d", starts, polls)
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("login wrote repository config")
	}
	out, err := runCLI(t, "", "whoami", "--server", server.URL)
	if err != nil || !strings.Contains(out, "Alice") {
		t.Fatalf("outside whoami: %s %v", out, err)
	}
}

func TestLogoutFailureRetainsLoginAndSuccessClearsChildren(t *testing.T) {
	dir := isolatedCLI(t)
	failRevocation := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/v1/me/token" || r.Header.Get("Authorization") != "Bearer setup" {
			t.Errorf("unexpected revoke %s %s", r.Method, r.URL.Path)
		}
		if failRevocation {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	keys := config.Keys{}
	link := config.Link{Server: server.URL, Organisation: "lab", Project: "web"}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Save(link, "scoped"); err != nil {
		t.Fatal(err)
	}
	if err := keys.TrackProject(link, "alice", "scoped"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.LinkDirectory(dir, link); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, config.FileName))
	// Account commands must not read repository state at all.
	outside := t.TempDir()
	t.Chdir(outside)
	_, err := runCLI(t, "", "logout", "--server", server.URL)
	requireExit(t, err, exitAPI, "revocation not confirmed")
	if _, _, err := keys.Login(server.URL, ""); err != nil {
		t.Fatal("failed logout discarded retry credential")
	}
	failRevocation = false
	out, err := runCLI(t, "", "logout", "--server", server.URL)
	if err != nil || !strings.Contains(out, "all its project keys") {
		t.Fatalf("logout %s %v", out, err)
	}
	if _, _, err := keys.Login(server.URL, ""); !errors.Is(err, config.ErrNoLogin) {
		t.Fatalf("login survived logout: %v", err)
	}
	if _, err := keys.LoadStored(link); !errors.Is(err, config.ErrNoKey) {
		t.Fatalf("child survived logout: %v", err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, config.FileName))
	if !bytes.Equal(before, after) {
		t.Fatal("logout changed YAML")
	}
	if ok, err := keys.HasBinding(dir); err != nil || !ok {
		t.Fatalf("logout removed private project binding: %v", err)
	}
}

func TestInteractiveInitRetriesConflictsWithoutRecreatingOrganisation(t *testing.T) {
	isolatedCLI(t)
	orgCalls, projectCalls, issuance := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/me":
			if r.Header.Get("Authorization") == "Bearer setup" {
				setupMe(w)
			} else {
				io.WriteString(w, `{"token_kind":"project","user":{"id":"alice"},"scope":{"workspace_slug":"new-org","project_key":"new-key"}}`)
			}
		case "/api/v1/orgs":
			orgCalls++
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "New team" || body["issue_prefix"] != "NEW" {
				t.Errorf("lost org fields: %+v", body)
			}
			if orgCalls == 1 {
				w.WriteHeader(http.StatusConflict)
			} else if body["slug"] != "new-org" {
				t.Errorf("slug not retried: %+v", body)
			}
		case "/api/v1/w/new-org/projects":
			if r.Method == http.MethodGet {
				io.WriteString(w, `{"projects":[]}`)
				return
			}
			projectCalls++
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "New project" {
				t.Errorf("lost project name: %+v", body)
			}
			if projectCalls == 1 {
				w.WriteHeader(http.StatusConflict)
			} else if body["key"] != "new-key" {
				t.Errorf("key not retried: %+v", body)
			}
		case "/api/v1/cli/project-tokens":
			issuance++
			io.WriteString(w, `{"token":"scoped","kind":"project","workspace_slug":"new-org","project_key":"new-key"}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	if _, err := (config.Keys{}).SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	input := "0\nNew team\nused-org\nNEW\nnew-org\n0\nNew project\nused-key\nnew-key\nyes\n"
	out, err := runCLI(t, input, "init", "--server", server.URL)
	if err != nil {
		t.Fatalf("interactive init: %s %v", out, err)
	}
	if orgCalls != 2 || projectCalls != 2 || issuance != 1 {
		t.Fatalf("calls org=%d project=%d issue=%d", orgCalls, projectCalls, issuance)
	}
	if strings.Contains(out, "View only") {
		t.Fatal("viewer membership offered for setup")
	}
	for _, text := range []string{"Account: alice", "Organisation: new-org", "Project: new-key", "Config:", "Type yes"} {
		if !strings.Contains(out, text) {
			t.Errorf("missing summary %q: %s", text, out)
		}
	}
}

func TestInitCancellationDoesNotMintProjectCredential(t *testing.T) {
	dir := isolatedCLI(t)
	issued := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/me" {
			setupMe(w)
			return
		}
		issued++
		w.WriteHeader(500)
	}))
	defer server.Close()
	if _, err := (config.Keys{}).SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	_, err := runCLI(t, "no\n", "init", "--server", server.URL, "--organisation", "lab", "--project", "web")
	requireExit(t, err, exitUsage, "cancelled")
	if issued != 0 {
		t.Fatal("cancelled init minted a project token")
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled init wrote YAML")
	}
}

func TestInitWriteFailureRevokesNewTokenAndRemovesLocalKey(t *testing.T) {
	dir := isolatedCLI(t)
	revoked := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/me":
			if r.Header.Get("Authorization") == "Bearer setup" {
				setupMe(w)
			} else {
				projectMe(w, "alice", "web")
			}
		case "/api/v1/cli/project-tokens":
			// Simulate a filesystem failure after the remote grant was issued.
			if err := os.Mkdir(filepath.Join(dir, config.FileName), 0o755); err != nil {
				t.Error(err)
			}
			io.WriteString(w, `{"token":"scoped","kind":"project","workspace_slug":"lab","project_key":"web"}`)
		case "/api/v1/me/token":
			revoked++
			if r.Method != http.MethodDelete || r.Header.Get("Authorization") != "Bearer scoped" {
				t.Error("rollback revoked wrong credential")
			}
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	keys := config.Keys{}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup"); err != nil {
		t.Fatal(err)
	}
	_, err := runCLI(t, "", "init", "--server", server.URL, "--organisation", "lab", "--project", "web", "--non-interactive")
	requireExit(t, err, exitConfig, "could not link directory")
	if revoked != 1 {
		t.Fatalf("orphan credential not revoked: %d", revoked)
	}
	if _, err := keys.LoadStored(config.Link{Server: server.URL, Organisation: "lab", Project: "web"}); !errors.Is(err, config.ErrNoKey) {
		t.Fatalf("local orphan survived: %v", err)
	}
	if ok, err := keys.HasBinding(dir); err != nil || ok {
		t.Fatalf("failed init created binding: %v", err)
	}
	if _, _, err := keys.Login(server.URL, ""); err != nil {
		t.Fatal("rollback removed setup login")
	}
}

func TestLoginPendingThenDeniedOrExpiredDoesNotSaveCredentials(t *testing.T) {
	for _, code := range []string{"access_denied", "expired_token"} {
		t.Run(code, func(t *testing.T) {
			dir := isolatedCLI(t)
			polls := 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/cli/sessions" {
					json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "ABCD-EFGH", "verification_uri_complete": server.URL + "/cli/authorize?code=ABCD-EFGH", "expires_at": time.Now().Add(time.Minute), "interval": 1})
					return
				}
				if r.URL.Path != "/api/v1/cli/sessions/token" {
					t.Errorf("unexpected request %s", r.URL.Path)
				}
				polls++
				answer := "authorization_pending"
				if polls > 1 {
					answer = code
				}
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, `{"error":{"code":%q}}`, answer)
			}))
			defer server.Close()
			_, err := runCLI(t, "", "login", "--server", server.URL, "--no-browser")
			requireExit(t, err, exitAuth, "")
			if polls != 2 {
				t.Fatalf("pending flow polls=%d", polls)
			}
			if _, _, err := (config.Keys{}).Login(server.URL, ""); !errors.Is(err, config.ErrNoLogin) {
				t.Fatalf("failed consent saved login: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, config.FileName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed login wrote YAML")
			}
		})
	}
}
