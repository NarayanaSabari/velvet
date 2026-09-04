package api_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// A test-only value, not a credential: it never leaves this process and is not
// the secret configured for any real GitHub App.
const testWebhookSecret = "test-only-webhook-value"

func signedRequest(t *testing.T, event, deliveryID, body string) *http.Request {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(testWebhookSecret))
	mac.Write([]byte(body))
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	req := httptest.NewRequest(http.MethodPost, "/webhooks/github", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", deliveryID)
	req.Header.Set("X-Hub-Signature-256", sig)
	return req
}

func TestWebhookRejectsABadSignature(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	req := signedRequest(t, "pull_request", "d1", `{"action":"opened"}`)
	req.Header.Set("X-Hub-Signature-256", "sha256=deadbeef")

	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM github_event`).Scan(&count))
	require.Equal(t, 0, count, "an unverified payload must never be stored")
}

func TestWebhookStoresAndEnqueues(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "d1", `{"action":"opened"}`))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var eventType string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT event_type FROM github_event WHERE delivery_id = 'd1'`).Scan(&eventType))
	require.Equal(t, "pull_request", eventType)

	var jobs int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job WHERE kind = 'process_delivery'`).Scan(&jobs))
	require.Equal(t, 1, jobs)
}

func TestRedeliveryIsANoOp(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "same-id", `{"action":"opened"}`))
		require.Equal(t, http.StatusOK, rec.Code,
			"a redelivery must still answer 200 so GitHub stops retrying")
	}

	var events, jobs int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM github_event`).Scan(&events))
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM job`).Scan(&jobs))
	require.Equal(t, 1, events)
	require.Equal(t, 1, jobs, "a duplicate delivery must not enqueue a second job")
}

func TestWebhookRejectsAnOversizedBody(t *testing.T) {
	f := testutil.NewFixtureWithWebhookSecret(t, testWebhookSecret)

	huge := `{"data":"` + strings.Repeat("x", 30<<20) + `"}`
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, signedRequest(t, "pull_request", "big", huge))
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
}
