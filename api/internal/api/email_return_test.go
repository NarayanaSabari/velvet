package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestEmailLoginReturnsToCLIConsentWithoutBrowserState(t *testing.T) {
	f := testutil.NewFixture(t)
	mailer := &recordingMailer{}
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{Mailer: mailer}).Handler()
	const destination = "/cli/approve?code=ABCD-EFGH"
	rec := authRequest(h, http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "cli-return@example.com", "return_to": destination})
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	require.Len(t, mailer.messages, 1)
	text := mailer.messages[0].Text
	token := strings.Fields(text[strings.Index(text, "#token=")+len("#token="):])[0]
	// Only the email token crosses to this second request, as with a new tab.
	confirmed := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
	require.Equal(t, http.StatusOK, confirmed.Code, confirmed.Body.String())
	require.JSONEq(t, `{"next":"/cli/approve?code=ABCD-EFGH"}`, confirmed.Body.String())
	replay := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
	require.Equal(t, http.StatusGone, replay.Code)
}

func TestEmailLoginRejectsUntrustedReturnPathsBeforeIssuance(t *testing.T) {
	f := testutil.NewFixture(t)
	mailer := &recordingMailer{}
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{Mailer: mailer}).Handler()
	for _, path := range []string{
		"https://evil.example/cli/approve?code=ABCD-EFGH", "//evil.example", "/\\evil.example",
		"/cli/approve?code=ABCD-EFGH&next=https://evil.example", "/cli/approve?code=ABCD-EFGH#fragment",
		"/cli/approve?code=ABCD-EFGH\n", "/w/lab", "/cli/approve?code=not-a-code",
	} {
		t.Run(path, func(t *testing.T) {
			rec := authRequest(h, http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "cli-return@example.com", "return_to": path})
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		})
	}
	require.Empty(t, mailer.messages)
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&count))
	require.Zero(t, count)
}
