package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestResendPostsMessage(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		require.Equal(t, "/emails", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.WriteHeader(200)
		w.Write([]byte(`{"id":"1"}`))
	}))
	defer srv.Close()

	m := NewResend("re_key", "Velvet <no@x>", srv.Client(), srv.URL)
	require.NoError(t, m.Send(context.Background(), Message{To: "a@x", Subject: "s", Text: "t", HTML: "<p>t</p>"}))
	require.Equal(t, "Bearer re_key", auth)
	require.Equal(t, "Velvet <no@x>", got["from"])
	require.Equal(t, []any{"a@x"}, got["to"])
	require.Equal(t, "s", got["subject"])
}

func TestResendReportsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		w.Write([]byte(`{"message":"bad from"}`))
	}))
	defer srv.Close()
	m := NewResend("k", "f", srv.Client(), srv.URL)
	err := m.Send(context.Background(), Message{To: "a@x"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "422")
}
