package client

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthenticatedAPIDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/api/v1/me", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	api := New(origin.URL, "private-project-token", "test")
	if err := api.Do(http.MethodGet, "/me", nil, nil, nil); StatusOf(err) != http.StatusTemporaryRedirect {
		t.Fatalf("redirect accepted: %v", err)
	}
	if calls != 0 {
		t.Fatal("bearer request followed redirect to another origin")
	}
}
