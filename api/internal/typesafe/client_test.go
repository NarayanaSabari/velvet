package typesafe_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/typesafe"
)

func TestNewWithoutKeyIsOff(t *testing.T) {
	require.Nil(t, typesafe.New("  ", "", ""))
}

func TestChoicesSendsTheDocumentedRequestShape(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/systemone", r.URL.Path)
		require.Equal(t, "Bearer ts-key", r.Header.Get("Authorization"))
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"issue":{"type":"choice","choice":"ENG-1","confidence":0.8,"probabilities":{"ENG-1":0.9,"none":0.1}}},"usage":{"input_tokens":10,"output_tokens":1}}`))
	}))
	defer srv.Close()

	c := typesafe.New("ts-key", srv.URL, "")
	res, err := c.Choices(t.Context(), map[string]any{"pr": "x"}, map[string]typesafe.Choice{
		"issue": {Instructions: "Which issue?", Criteria: map[string]string{"ENG-1": "Fix auth", "none": "None"}},
	})
	require.NoError(t, err)
	require.Equal(t, "jev-1.13.0", res.Model)
	require.Equal(t, "ENG-1", res.Answers["issue"].Choice)
	require.InDelta(t, 0.9, res.Answers["issue"].Probabilities["ENG-1"], 1e-9)

	require.Equal(t, "jev-latest", got["model"])
	q := got["questions"].(map[string]any)["issue"].(map[string]any)
	require.Equal(t, "choice", q["type"])
	require.Equal(t, "Which issue?", q["instructions"])
}

func TestChoicesClassifiesFailures(t *testing.T) {
	for _, tc := range []struct {
		status int
		check  func(error) bool
	}{
		{http.StatusUnauthorized, func(err error) bool { return errors.Is(err, typesafe.ErrUnauthorized) }},
		{http.StatusBadRequest, func(err error) bool { return errors.Is(err, typesafe.ErrRejected) }},
		{http.StatusUnprocessableEntity, func(err error) bool { return errors.Is(err, typesafe.ErrRejected) }},
		{http.StatusTooManyRequests, func(err error) bool { var e *typesafe.APIError; return errors.As(err, &e) }},
		{529, func(err error) bool { var e *typesafe.APIError; return errors.As(err, &e) }},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(`{"detail":"secret state echoed"}`))
		}))
		_, err := typesafe.New("k", srv.URL, "").Choices(t.Context(), "s", map[string]typesafe.Choice{"q": {Instructions: "?", Criteria: map[string]string{"a": "a"}}})
		srv.Close()
		require.Error(t, err)
		require.True(t, tc.check(err), "status %d gave %v", tc.status, err)
		require.NotContains(t, err.Error(), "secret state", "provider bodies must not reach logs")
	}
}

func TestChoicesRejectsAMissingAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"m","answers":{},"usage":{}}`))
	}))
	defer srv.Close()
	_, err := typesafe.New("k", srv.URL, "").Choices(t.Context(), "s", map[string]typesafe.Choice{"q": {Instructions: "?", Criteria: map[string]string{"a": "a"}}})
	require.ErrorContains(t, err, "missing")
}
