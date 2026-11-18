package main

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

const (
	rakeshID = "22222222-2222-4222-8222-222222222222"
	rakiID   = "33333333-3333-4333-8333-333333333333"
)

func membersFixture() []member {
	gh := "rakesh-gh"
	return []member{
		{ID: rakeshID, Email: "rakesh@aesthatiq.com", Name: "Rakesh Kumar", GitHubLogin: &gh},
		{ID: rakiID, Email: "rakhi@aesthatiq.com", Name: "Rakhi Nair"},
	}
}

func TestMatchMember(t *testing.T) {
	for _, tc := range []struct {
		query, want, errHas string
	}{
		{"rakesh@aesthatiq.com", rakeshID, ""},
		{"RAKESH@AESTHATIQ.COM", rakeshID, ""},
		{"rakesh-gh", rakeshID, ""},
		{"rakesh", rakeshID, ""},
		{"Nair", rakiID, ""},
		{"rak", "", "matches 2 members"},
		{"nobody", "", "no member matches"},
	} {
		m, err := matchMember(membersFixture(), tc.query)
		if tc.errHas != "" {
			if err == nil || !strings.Contains(err.Error(), tc.errHas) {
				t.Errorf("%q: err=%v, want %q", tc.query, err, tc.errHas)
			}
			continue
		}
		if err != nil || m.ID != tc.want {
			t.Errorf("%q: got %s err=%v, want %s", tc.query, m.ID, err, tc.want)
		}
	}
}

func TestEditAssigneeByName(t *testing.T) {
	var patched map[string]any
	e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/w/lab/members":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": membersFixture()})
		case r.Method == "PATCH" && r.URL.Path == "/api/v1/w/lab/issues/LAB-1":
			_ = json.NewDecoder(r.Body).Decode(&patched)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	if _, err := runTicketCommand(e, "edit", []string{"LAB-1", "--assignee", "rakesh"}, nil); err != nil {
		t.Fatal(err)
	}
	if patched["assignee_id"] != rakeshID {
		t.Fatalf("patched %#v", patched)
	}
}

func TestEditAmbiguousAssigneeNeverPatches(t *testing.T) {
	e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"members": membersFixture()})
	})
	_, err := runTicketCommand(e, "edit", []string{"LAB-1", "--assignee", "rak"}, nil)
	if err == nil || !strings.Contains(err.Error(), "Rakesh Kumar <rakesh@aesthatiq.com>") {
		t.Fatalf("err=%v", err)
	}
}

func TestCommentAddWithImages(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/proof.png"
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	var uploads []map[string]string
	e, out := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/v1/w/lab/issues/LAB-1/comments":
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": ticketTestID})
		case r.Method == "POST" && r.URL.Path == "/api/v1/w/lab/issues/LAB-1/images":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			uploads = append(uploads, map[string]string{"caption": r.FormValue("caption"), "comment_id": r.FormValue("comment_id")})
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "img"})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	args := []string{"LAB-1", "add", "--image", path + "#Login screen", "--image", path, "Proof"}
	if _, err := runTicketCommand(e, "comments", args, nil); err != nil {
		t.Fatal(err)
	}
	want := []map[string]string{{"caption": "Login screen", "comment_id": ticketTestID}, {"caption": "proof.png", "comment_id": ticketTestID}}
	if !reflect.DeepEqual(uploads, want) {
		t.Fatalf("uploads %#v", uploads)
	}
	if !strings.Contains(out.String(), "2 image(s)") {
		t.Fatalf("output %s", out)
	}
}

func TestCommentImageMissingFileNeverPosts(t *testing.T) {
	e, _ := ticketTestEnv(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
	})
	if _, err := runTicketCommand(e, "comments", []string{"LAB-1", "add", "--image", "/nope.png", "x"}, nil); err == nil {
		t.Fatal("want error")
	}
}
