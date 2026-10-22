package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

func TestManagementLoginAndLogoutAreSeparate(t *testing.T) {
	isolatedCLI(t)
	calls, grants, revoked := 0, 0, false
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.URL.Path {
		case "/api/v1/cli/sessions":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["flow"] != "manage" || r.Header.Get("Authorization") != "" {
				t.Errorf("wrong management request: %v", body)
			}
			grants++
			json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "ABCD-EFGH", "verification_uri_complete": server.URL + "/cli/approve?code=ABCD-EFGH", "expires_at": time.Now().Add(time.Minute), "interval": 1})
		case "/api/v1/cli/sessions/token":
			io.WriteString(w, `{"token":"management-secret","kind":"personal"}`)
		case "/api/v1/me":
			if r.Header.Get("Authorization") != "Bearer management-secret" {
				t.Errorf("used wrong credential")
			}
			io.WriteString(w, `{"token_kind":"personal","user":{"id":"alice","name":"Alice"}}`)
		case "/api/v1/me/token":
			revoked = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	keys := config.Keys{}
	if _, err := keys.SaveLogin(server.URL, "alice", "setup-secret"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		out, err := runCLI(t, "", "admin", "login", "--server", server.URL, "--no-browser")
		if err != nil {
			t.Fatalf("login: %s %v", out, err)
		}
		if strings.Contains(out, "management-secret") {
			t.Fatal("printed management secret")
		}
	}
	if grants != 1 {
		t.Fatalf("repeat login created %d grants", grants)
	}
	if _, token, err := keys.Management(server.URL, ""); err != nil || token != "management-secret" {
		t.Fatalf("missing management credential %v", err)
	}
	before := calls
	_, err := runCLI(t, "", "admin", "logout", "--server", server.URL)
	requireExit(t, err, exitUsage, "--yes")
	if calls != before {
		t.Fatal("unconfirmed revoke reached server")
	}
	if _, err := runCLI(t, "", "admin", "logout", "--server", server.URL, "--yes"); err != nil {
		t.Fatal(err)
	}
	if !revoked {
		t.Fatal("server credential not revoked")
	}
	if _, _, err := keys.Management(server.URL, ""); err == nil {
		t.Fatal("management credential survived")
	}
	if _, token, err := keys.Login(server.URL, ""); err != nil || token != "setup-secret" {
		t.Fatal("management logout removed setup")
	}
}

func TestManagementLoaderIgnoresYAMLAndRejectsOtherKinds(t *testing.T) {
	for _, kind := range []string{"setup", "project", "personal"} {
		t.Run(kind, func(t *testing.T) {
			dir := isolatedCLI(t)
			attackerCalls := 0
			attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attackerCalls++ }))
			defer attacker.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer management-secret" {
					t.Error("environment credential used")
				}
				fmt.Fprintf(w, `{"token_kind":%q,"user":{"id":"alice"}}`, kind)
			}))
			defer server.Close()
			config.Write(dir, config.Link{Server: attacker.URL, Organisation: "evil", Project: "evil"})
			t.Setenv("VELVET_TOKEN", "evil-secret")
			keys := config.Keys{}
			if _, err := keys.SaveManagement(server.URL, "alice", "management-secret"); err != nil {
				t.Fatal(err)
			}
			_, err := loadManagementEnv(server.URL, "alice", io.Discard, io.Discard)
			if (err == nil) != (kind == "personal") {
				t.Fatalf("kind %s: %v", kind, err)
			}
			if attackerCalls != 0 {
				t.Fatal("YAML redirected management credential")
			}
			if _, err := loadManagementEnv(server.URL, "bob", io.Discard, io.Discard); err == nil {
				t.Fatal("wrong account accepted")
			}
		})
	}
}

func TestManagementRevokeFailureRetainsCredential(t *testing.T) {
	isolatedCLI(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/me" {
			io.WriteString(w, `{"token_kind":"personal","user":{"id":"alice"}}`)
			return
		}
		w.WriteHeader(503)
	}))
	defer server.Close()
	keys := config.Keys{}
	keys.SaveManagement(server.URL, "alice", "secret")
	_, err := runCLI(t, "", "admin", "logout", "--server", server.URL, "--yes")
	if err == nil || !strings.Contains(err.Error(), "retained") {
		t.Fatalf("%v", err)
	}
	if _, _, err := keys.Management(server.URL, ""); err != nil {
		t.Fatal("failed revoke deleted credential")
	}
}

func TestProjectKeyPromptExplainsAndRetries(t *testing.T) {
	var out bytes.Buffer
	term := terminal{in: bufio.NewReader(strings.NewReader("AES\naesthatiq\n")), out: &out}
	key, err := term.projectKey()
	if err != nil || key != "aesthatiq" || !strings.Contains(out.String(), "not the uppercase issue prefix") {
		t.Fatalf("key=%s err=%v output=%s", key, err, &out)
	}
}
