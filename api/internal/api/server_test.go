package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	pool := testutil.NewPostgres(t)
	cfg := &config.Config{
		BaseURL: "http://localhost:8080",
	}
	return api.NewServer(pool, cfg, api.Dependencies{}).Handler()
}

func TestHealthReportsOK(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "ok", body["status"])
}

func TestUnknownRouteReturnsStructuredError(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil))

	require.Equal(t, http.StatusNotFound, rec.Code)
	var body api.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "not_found", body.Error.Code)
}

func TestPanicBecomesInternalError(t *testing.T) {
	h := api.Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("deliberate panic")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/test-only", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	var body api.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "internal", body.Error.Code)
	require.NotContains(t, rec.Body.String(), "deliberate panic",
		"internal detail must never reach the client")
}

func TestPanicTestRouteIsNotPublic(t *testing.T) {
	h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/panic-test", nil))

	require.Equal(t, http.StatusNotFound, rec.Code)
}
