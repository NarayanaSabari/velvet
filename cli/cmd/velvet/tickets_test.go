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

const ticketTestID = "11111111-1111-4111-8111-111111111111"

func ticketTestEnv(t *testing.T, handler http.HandlerFunc) (*env, *bytes.Buffer) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("VELVET_NO_KEYCHAIN", "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fake-project-token" {
			t.Error("missing project credential")
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	out := &bytes.Buffer{}
	return &env{repo: config.Repo{Link: config.Link{Organisation: "lab", Project: "web"}}, api: client.New(server.URL, "fake-project-token", "test"), out: out, errOut: io.Discard}, out
}

func TestTicketEditPatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want map[string]any
	}{
		{"clear", []string{"LAB-1", "--desc=", "--assignee", "none", "--milestone", "none", "--priority", "0"}, map[string]any{"description": "", "assignee_id": nil, "milestone_id": nil, "priority": float64(0)}},
		{"assign", []string{"lab-1", "--title", "New title", "--assignee", ticketTestID, "--milestone", ticketTestID}, map[string]any{"title": "New title", "assignee_id": ticketTestID, "milestone_id": ticketTestID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			e, out := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "PATCH" || r.URL.Path != "/api/v1/w/lab/issues/LAB-1" {
					t.Errorf("request %s %s", r.Method, r.URL.Path)
				}
				var got map[string]any
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, tc.want) {
					t.Errorf("payload %#v, want %#v", got, tc.want)
				}
				w.WriteHeader(200)
			})
			handled, err := runTicketCommand(e, "edit", tc.args, nil)
			if !handled || err != nil || calls != 1 || !strings.Contains(out.String(), "Status unchanged") {
				t.Fatalf("handled=%v err=%v calls=%d output=%s", handled, err, calls, out)
			}
		})
	}
}

func TestTicketInvalidArgumentsNeverRequest(t *testing.T) {
	cases := []struct {
		cmd  string
		args []string
	}{
		{"comments", []string{"--milestone"}},
		{"comments", []string{"--milestone", ticketTestID}},
		{"comments", []string{"--milestone", "bad", "list"}},
		{"comments", []string{"--milestone", ticketTestID, "list", "extra"}},
		{"comments", []string{"--milestone", ticketTestID, "delete", ticketTestID}},
		{"edit", nil}, {"edit", []string{"LAB-1"}}, {"edit", []string{"../bad", "--title", "x"}},
		{"edit", []string{"LAB-1", "--title", " "}}, {"edit", []string{"LAB-1", "--priority", "5"}},
		{"edit", []string{"LAB-1", "--assignee", ""}}, {"edit", []string{"LAB-1", "--milestone", "bad"}},
		{"edit", []string{"LAB-1", "--labels", "one"}}, {"edit", []string{"LAB-1", "--title", "x", "extra"}},
		{"comments", []string{"LAB-1", "list", "extra"}}, {"comments", []string{"LAB-1", "delete", ticketTestID}},
		{"comments", []string{"LAB-1", "delete", ticketTestID, "--yes=false"}},
		{"comments", []string{"LAB-1", "delete", ticketTestID, "--yes", "extra"}},
		{"comments", []string{"LAB-1", "add", "--kind", "bad", "body"}},
		{"comments", []string{"LAB-1", "add", "--parent", "bad", "body"}},
		{"comments", []string{"LAB-1", "edit", "bad", "body"}},
		{"comments", []string{"LAB-1", "add", "body", "--kind", "note"}},
		{"comments", []string{"--project", "add"}}, {"comments", []string{"--project", "edit", ticketTestID}},
		{"evidence", []string{"LAB-1", "delete"}}, {"evidence", []string{"LAB-1", "list", "extra"}},
	}
	for _, tc := range cases {
		t.Run(tc.cmd+" "+strings.Join(tc.args, " "), func(t *testing.T) {
			e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid command reached API") })
			handled, err := runTicketCommand(e, tc.cmd, tc.args, strings.NewReader(""))
			var ee exitError
			if !handled || !errors.As(err, &ee) || ee.code != exitUsage {
				t.Fatalf("handled=%v error=%v", handled, err)
			}
		})
	}
}

func TestTicketCommentsMutations(t *testing.T) {
	for _, op := range []string{"add", "edit", "delete"} {
		for _, target := range []string{"LAB-1", "--project", "--milestone"} {
			t.Run(target+op, func(t *testing.T) {
				calls := 0
				path := "/api/v1/w/lab/issues/LAB-1/comments"
				if target == "--project" {
					path = "/api/v1/w/lab/projects/web/comments"
				} else if target == "--milestone" {
					path = "/api/v1/w/lab/milestones/" + ticketTestID + "/comments"
				}
				e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.Method == "GET" {
						if r.URL.Path != path {
							t.Errorf("list path %s", r.URL.Path)
						}
						io.WriteString(w, `{"comments":[{"id":"other","replies":[{"id":"`+ticketTestID+`"}]}]}`)
						return
					}
					wantMethod := "POST"
					wantPath := path
					if op != "add" {
						wantPath = "/api/v1/w/lab/comments/" + ticketTestID
						wantMethod = "PATCH"
					}
					if op == "delete" {
						wantMethod = "DELETE"
					}
					if r.Method != wantMethod || r.URL.Path != wantPath {
						t.Errorf("mutation %s %s", r.Method, r.URL.Path)
					}
					if op != "delete" {
						var payload map[string]string
						if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
							t.Fatal(err)
						}
						want := map[string]string{"body": "Body from stdin"}
						if op == "add" {
							want["kind"] = "note"
							want["parent_id"] = ticketTestID
						}
						if !reflect.DeepEqual(payload, want) {
							t.Errorf("payload %#v", payload)
						}
					} else {
						raw, _ := io.ReadAll(r.Body)
						if len(raw) != 0 {
							t.Errorf("delete body %s", raw)
						}
					}
					w.WriteHeader(204)
				})
				args := []string{target, op}
				if target == "--milestone" {
					args = []string{target, ticketTestID, op}
				}
				if op != "add" {
					args = append(args, ticketTestID)
				} else {
					args = append(args, "--kind", "note", "--parent", ticketTestID)
				}
				if op == "delete" {
					args = append(args, "--yes")
				}
				_, err := runTicketCommand(e, "comments", args, strings.NewReader("Body from stdin"))
				wantCalls := 2
				if op == "add" {
					wantCalls = 1
				}
				if err != nil || calls != wantCalls {
					t.Fatalf("err=%v calls=%d", err, calls)
				}
			})
		}
	}
}

func TestTicketCommentWrongTarget(t *testing.T) {
	e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("mutated wrong target")
		}
		io.WriteString(w, `{"comments":[]}`)
	})
	_, err := runTicketCommand(e, "comments", []string{"LAB-1", "delete", ticketTestID, "--yes"}, nil)
	var ee exitError
	if !errors.As(err, &ee) || ee.code != exitNotFound {
		t.Fatalf("error %v", err)
	}
}

func TestTicketListingsEscapeAndPreserveData(t *testing.T) {
	for _, cmd := range []string{"comments", "evidence"} {
		t.Run(cmd, func(t *testing.T) {
			response := `{"comments":[{"id":"id","replies":[{"body":"reply"}]}]}`
			args := []string{"--project", "list"}
			expected := "/api/v1/w/lab%2Fspace/projects/web%2Fpart/comments"
			if cmd == "evidence" {
				response = `{"pull_requests":[{"url":"https://example.test/pr"}],"reviews":[{"state":"approved"}],"commits":[{"sha":"abc"}]}`
				args = []string{"lab-1", "list"}
				expected = "/api/v1/w/lab%2Fspace/issues/LAB-1/evidence"
			}
			e, out := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.EscapedPath() != expected {
					t.Errorf("request %s %s", r.Method, r.URL.EscapedPath())
				}
				io.WriteString(w, response)
			})
			e.repo.Organisation = "lab/space"
			e.repo.Project = "web/part"
			_, err := runTicketCommand(e, cmd, args, nil)
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			json.Unmarshal([]byte(response), &want)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("output %s", out)
			}
		})
	}
}

func TestTicketMilestoneCommentsListAndContainment(t *testing.T) {
	for _, op := range []string{"list", "delete"} {
		t.Run(op, func(t *testing.T) {
			e, out := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/v1/w/lab/milestones/"+ticketTestID+"/comments" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				io.WriteString(w, `{"comments":[]}`)
			})
			args := []string{"--milestone", ticketTestID, op}
			if op == "delete" {
				args = append(args, ticketTestID, "--yes")
			}
			_, err := runTicketCommand(e, "comments", args, nil)
			if op == "list" {
				if err != nil || !strings.Contains(out.String(), `"comments": []`) {
					t.Fatalf("list err=%v output=%s", err, out)
				}
			} else {
				var ee exitError
				if !errors.As(err, &ee) || ee.code != exitNotFound {
					t.Fatalf("wrong target error %v", err)
				}
			}
		})
	}
}

func TestTicketAPIErrorsAndUnknownDispatch(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		code   int
	}{
		{403, `{"error":{"code":"out_of_scope","message":"wrong project"}}`, exitScope},
		{404, `{"error":{"message":"missing"}}`, exitNotFound},
		{401, `{}`, exitAuth},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); io.WriteString(w, tc.body) })
			_, err := runTicketCommand(e, "edit", []string{"LAB-1", "--title", "x"}, nil)
			var ee exitError
			if !errors.As(err, &ee) || ee.code != tc.code {
				t.Fatalf("error %v", err)
			}
		})
	}
	handled, err := runTicketCommand(nil, "attach", nil, nil)
	if handled || err != nil {
		t.Fatalf("unknown dispatch %v %v", handled, err)
	}
}
