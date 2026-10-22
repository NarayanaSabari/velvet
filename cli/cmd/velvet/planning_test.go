package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

const planningTestID = "12345678-1234-1234-1234-123456789abc"
const planningOtherID = "23456789-1234-1234-1234-123456789abc"

func isolatePlanningTest(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("APPDATA", home)
	t.Setenv("VELVET_NO_KEYCHAIN", "1")
}

func TestPlanningRoutesAndPayloads(t *testing.T) {
	isolatePlanningTest(t)
	tests := []struct {
		name, cmd    string
		args         []string
		method, path string
		body         map[string]string
	}{
		{"sprint show", "sprint", []string{planningTestID, "show"}, "GET", "/sprints/" + planningTestID, nil},
		{"sprint edit", "sprint", []string{planningTestID, "edit", "--name", "Next", "--starts-on", "2026-10-22", "--ends-on=2026-10-29"}, "PATCH", "/sprints/" + planningTestID, map[string]string{"name": "Next", "starts_on": "2026-10-22", "ends_on": "2026-10-29"}},
		{"activate", "sprint", []string{planningTestID, "activate", "--yes"}, "POST", "/sprints/" + planningTestID + "/activate", nil},
		{"complete", "sprint", []string{planningTestID, "complete", "--yes"}, "POST", "/sprints/" + planningTestID + "/close", nil},
		{"milestone show", "milestone", []string{planningTestID, "show"}, "GET", "/milestones/" + planningTestID, nil},
		{"milestone narrative and reorder", "milestone", []string{planningTestID, "edit", "--description", "Ship safely", "--target-date=", "--after", planningOtherID}, "PATCH", "/milestones/" + planningTestID, map[string]string{"description": "Ship safely", "target_date": "", "after_id": planningOtherID}},
		{"milestone owner", "milestone", []string{planningTestID, "edit", "--owner", planningOtherID}, "PATCH", "/milestones/" + planningTestID, map[string]string{"owner_id": planningOtherID}},
		{"clear milestone owner", "milestone", []string{planningTestID, "edit", "--owner", "none"}, "PATCH", "/milestones/" + planningTestID, map[string]string{"owner_id": ""}},
		{"milestone explicit complete", "milestone", []string{planningTestID, "edit", "--status", "completed", "--yes"}, "PATCH", "/milestones/" + planningTestID, map[string]string{"status": "completed"}},
		{"plural sprint edit", "sprints", []string{"edit", planningTestID, "--name", "Next"}, "PATCH", "/sprints/" + planningTestID, map[string]string{"name": "Next"}},
		{"plural milestone edit", "milestones", []string{"edit", planningTestID, "--before", planningOtherID}, "PATCH", "/milestones/" + planningTestID, map[string]string{"before_id": planningOtherID}},
		{"issue images", "images", []string{"eng-42"}, "GET", "/issues/ENG-42/images", nil},
		{"milestone images", "images", []string{"--milestone", planningTestID}, "GET", "/milestones/" + planningTestID + "/images", nil},
		{"delete image", "image", []string{planningTestID, "delete", "--yes"}, "DELETE", "/images/" + planningTestID, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != tt.method || r.URL.Path != "/api/v1/w/lab"+tt.path || r.URL.RawQuery != "" {
					t.Errorf("request: %s %s", r.Method, r.URL)
				}
				if r.Header.Get("Authorization") != "Bearer fake-project" {
					t.Error("missing credential")
				}
				raw, _ := io.ReadAll(r.Body)
				var body map[string]string
				if len(raw) > 0 {
					if err := json.Unmarshal(raw, &body); err != nil {
						t.Error(err)
					}
				}
				if !reflect.DeepEqual(body, tt.body) {
					t.Errorf("body %#v, want %#v", body, tt.body)
				}
				if tt.method == "DELETE" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				_, _ = io.WriteString(w, `{"id":"`+planningTestID+`","description":"Goal","images":[]}`)
			}))
			defer server.Close()
			var out bytes.Buffer
			e := env{repo: config.Repo{Link: config.Link{Organisation: "lab", Project: "ENG"}}, api: client.New(server.URL, "fake-project", "test"), out: &out, errOut: io.Discard}
			handled, err := runPlanningCommand(&e, tt.cmd, tt.args, strings.NewReader("yes\n"))
			if !handled || err != nil || calls != 1 || out.Len() == 0 {
				t.Fatalf("handled=%v err=%v calls=%d out=%s", handled, err, calls, out.String())
			}
		})
	}
}

func TestPlanningRejectsArgumentsBeforeRequests(t *testing.T) {
	isolatePlanningTest(t)
	cases := []struct {
		cmd  string
		args []string
	}{
		{"sprint", nil}, {"sprint", []string{"../bad", "show"}}, {"sprint", []string{strings.Repeat("0", 8) + "-0000-0000-0000-000000000000", "show"}},
		{"sprint", []string{planningTestID, "activate"}}, {"sprint", []string{planningTestID, "complete"}}, {"image", []string{planningTestID, "delete"}},
		{"sprint", []string{planningTestID, "activate", "--yes=false"}}, {"sprint", []string{planningTestID, "activate", "--yes", "extra"}},
		{"sprint", []string{planningTestID, "edit"}}, {"sprint", []string{planningTestID, "edit", "--name", " "}},
		{"sprint", []string{planningTestID, "edit", "--name"}}, {"sprint", []string{planningTestID, "edit", "--name", "A", "--name", "B"}},
		{"sprint", []string{planningTestID, "edit", "--starts-on", "2026-02-30"}}, {"sprint", []string{planningTestID, "edit", "--starts-on", "2026-2-01"}},
		{"sprint", []string{planningTestID, "edit", "--starts-on", "2026-11-01", "--ends-on", "2026-10-01"}},
		{"milestone", []string{planningTestID, "edit", "--status", "done"}}, {"milestone", []string{planningTestID, "edit", "--status", "completed"}},
		{"milestone", []string{planningTestID, "edit", "--status", "cancelled"}}, {"milestone", []string{planningTestID, "edit", "--target-date", "bad"}},
		{"milestone", []string{planningTestID, "edit", "--after", "bad"}}, {"milestone", []string{planningTestID, "edit", "--after", planningTestID}},
		{"milestone", []string{planningTestID, "edit", "--after", planningOtherID, "--before", planningOtherID}},
		{"milestone", []string{planningTestID, "edit", "--owner", "bad"}},
		{"milestone", []string{planningTestID, "edit", "--owner", ""}},
		{"milestone", []string{planningTestID, "edit", "--owner", "00000000-0000-0000-0000-000000000000"}},
		{"milestone", []string{planningTestID, "edit", "--owner"}},
		{"milestone", []string{planningTestID, "edit", "--goals", "invented"}}, {"milestone", []string{planningTestID, "show", "extra"}},
		{"images", []string{"ENG-1", "--milestone", planningTestID}}, {"images", nil}, {"images", []string{"--milestone", "bad"}},
		{"image", []string{planningTestID, "show"}}, {"sprints", []string{"edit"}},
	}
	for _, tt := range cases {
		t.Run(tt.cmd+" "+strings.Join(tt.args, " "), func(t *testing.T) {
			// A nil API makes any accidental work request fail this test immediately.
			e := env{out: io.Discard, errOut: io.Discard}
			handled, err := runPlanningCommand(&e, tt.cmd, tt.args, strings.NewReader("yes\n"))
			var ee exitError
			if !handled || !errors.As(err, &ee) || ee.code != exitUsage {
				t.Fatalf("handled=%v err=%v", handled, err)
			}
		})
	}
}

func TestPlanningLeavesExistingCommandsAndMapsErrors(t *testing.T) {
	isolatePlanningTest(t)
	e := env{out: io.Discard, errOut: io.Discard}
	for _, tt := range []struct {
		cmd  string
		args []string
	}{{"sprints", nil}, {"sprints", []string{"new", "Name", "2026-01-01", "2026-01-02"}}, {"milestones", nil}, {"milestones", []string{planningTestID}}, {"milestones", []string{"new", planningTestID, "Name"}}, {"other", nil}} {
		handled, err := runPlanningCommand(&e, tt.cmd, tt.args, nil)
		if handled || err != nil {
			t.Fatalf("intercepted %s: %v", tt.cmd, err)
		}
	}
	for _, code := range []int{http.StatusNotFound, http.StatusForbidden, http.StatusUnauthorized} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
			_, _ = io.WriteString(w, `{"error":{"code":"out_of_scope","message":"wrong project"}}`)
		}))
		e.repo = config.Repo{Link: config.Link{Organisation: "lab"}}
		e.api = client.New(server.URL, "fake", "test")
		_, err := runPlanningCommand(&e, "sprint", []string{planningTestID, "show"}, nil)
		var ee exitError
		want := exitScope
		if code == http.StatusUnauthorized {
			want = exitAuth
		}
		if !errors.As(err, &ee) || ee.code != want {
			t.Errorf("status %d: %v", code, err)
		}
		server.Close()
	}
}
