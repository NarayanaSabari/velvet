package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/mail"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

type recordingMailer struct {
	messages   []mail.Message
	err        error
	beforeSend func()
}

func (m *recordingMailer) Send(_ context.Context, msg mail.Message) error {
	if m.beforeSend != nil {
		m.beforeSend()
	}
	m.messages = append(m.messages, msg)
	return m.err
}

func authRequest(h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Origin", "https://velvet.example.com")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// A browser must explicitly POST, receive one usable session, and be unable to replay the link.
func TestMagicConfirmationCreatesOneSessionAndGETDoesNotConsume(t *testing.T) {
	f := testutil.NewFixture(t)
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{}).Handler()
	token, err := f.Store.IssueLoginToken(t.Context(), "new@example.com", "127.0.0.1", nil)
	require.NoError(t, err)
	get := authRequest(h, http.MethodGet, "/api/v1/auth/magic?token="+token, nil)
	require.Equal(t, 405, get.Code)
	require.Empty(t, get.Result().Cookies())
	post := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
	require.Equal(t, 200, post.Code, post.Body.String())
	require.JSONEq(t, `{"next":"/orgs/new"}`, post.Body.String())
	cookies := post.Result().Cookies()
	require.Len(t, cookies, 1)
	c := cookies[0]
	require.Equal(t, auth.CookieName, c.Name)
	require.True(t, c.HttpOnly)
	require.True(t, c.Secure)
	require.Equal(t, "/", c.Path)
	require.Equal(t, http.SameSiteLaxMode, c.SameSite)
	require.WithinDuration(t, time.Now().Add(30*24*time.Hour), c.Expires, 3*time.Second)
	u, err := f.Store.UserBySessionToken(t.Context(), c.Value)
	require.NoError(t, err)
	require.Equal(t, "new@example.com", u.Email)
	replay := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
	require.Equal(t, 410, replay.Code)
	require.Contains(t, replay.Body.String(), `"code":"expired"`)
	require.Empty(t, replay.Result().Cookies())
}

// Dead invitations must roll back even when issuance happened after revocation.
func TestMagicInvalidInviteRollsBackUserSessionAndConsumption(t *testing.T) {
	for _, state := range []string{"expired", "revoked", "accepted", "wrong_email"} {
		t.Run(state, func(t *testing.T) {
			f := testutil.NewFixture(t)
			i, _, err := f.Store.CreateInvite(t.Context(), f.WorkspaceID, f.User.ID, "new@example.com", "member")
			require.NoError(t, err)
			switch state {
			case "expired":
				_, err = f.Pool.Exec(t.Context(), `UPDATE invite SET expires_at=now()-interval '1 second' WHERE id=$1`, i.ID)
			case "revoked":
				err = f.Store.RevokeInvite(t.Context(), f.WorkspaceID, i.ID, f.User.ID)
			case "accepted":
				_, err = f.Pool.Exec(t.Context(), `UPDATE invite SET accepted_at=now() WHERE id=$1`, i.ID)
			case "wrong_email":
				_, err = f.Pool.Exec(t.Context(), `UPDATE invite SET email='other@example.com' WHERE id=$1`, i.ID)
			}
			require.NoError(t, err)
			token, err := f.Store.IssueLoginToken(t.Context(), "new@example.com", "127.0.0.1", &i.ID)
			require.NoError(t, err)
			h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{}).Handler()
			rec := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
			require.Equal(t, 410, rec.Code, rec.Body.String())
			require.Empty(t, rec.Result().Cookies())
			var users, sessions, consumed int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM app_user WHERE email='new@example.com'), (SELECT count(*) FROM session WHERE user_id != $1), (SELECT count(*) FROM login_token WHERE consumed_at IS NOT NULL)`, f.User.ID).Scan(&users, &sessions, &consumed))
			require.Zero(t, users)
			require.Zero(t, sessions)
			require.Zero(t, consumed)
		})
	}
}

func TestMagicExpiredLoginAndStorageFailure(t *testing.T) {
	f := testutil.NewFixture(t)
	token, err := f.Store.IssueLoginToken(t.Context(), "new@example.com", "127.0.0.1", nil)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `UPDATE login_token SET expires_at=now()-interval '1 second'`)
	require.NoError(t, err)
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{}).Handler()
	require.Equal(t, 410, authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token}).Code)
	f.Pool.Close()
	rec := authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token})
	require.Equal(t, 500, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"internal"`)
}

func TestEmailRejectsInvalidAddress(t *testing.T) {
	h := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email", bytes.NewBufferString(`{"email":"not-an-email"}`))
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"invalid_request"`)
}

// Mail must be sent only after durable issuance, with a fragment token that authenticates.
func TestEmailSendsCommittedLinkAndHidesKnownUnknownAndLimitedAddresses(t *testing.T) {
	f := testutil.NewFixture(t)
	m := &recordingMailer{}
	m.beforeSend = func() {
		var n int
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&n))
		require.Equal(t, len(m.messages)+1, n)
	}
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{Mailer: m}).Handler()
	for _, email := range []string{f.User.Email, " New@Example.COM ", "new@example.com", "new@example.com", "new@example.com", "new@example.com", "new@example.com"} {
		rec := authRequest(h, http.MethodPost, "/api/v1/auth/email", map[string]string{"email": email})
		require.Equal(t, 202, rec.Code, rec.Body.String())
		require.JSONEq(t, `{"status":"sent"}`, rec.Body.String())
	}
	require.Len(t, m.messages, 6)
	msg := m.messages[1]
	require.Equal(t, "new@example.com", msg.To)
	require.Contains(t, msg.Text, "https://velvet.example.com/signin/confirm#token=")
	require.Contains(t, msg.HTML, "https://velvet.example.com/signin/confirm#token=")
	start := strings.Index(msg.Text, "#token=") + len("#token=")
	token := strings.Fields(msg.Text[start:])[0]
	require.Equal(t, 200, authRequest(h, http.MethodPost, "/api/v1/auth/magic", map[string]string{"token": token}).Code)
}

func TestEmailMailFailureRetainsCounterWithoutRetry(t *testing.T) {
	f := testutil.NewFixture(t)
	m := &recordingMailer{err: errors.New("provider failure containing private details")}
	h := api.NewServer(f.Pool, &config.Config{BaseURL: "https://velvet.example.com"}, api.Dependencies{Mailer: m}).Handler()
	for range 6 {
		rec := authRequest(h, http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "new@example.com"})
		require.Equal(t, 202, rec.Code)
		require.JSONEq(t, `{"status":"sent"}`, rec.Body.String())
	}
	require.Len(t, m.messages, 5)
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token`).Scan(&n))
	require.Equal(t, 5, n)
	f.Pool.Close()
	rec := authRequest(h, http.MethodPost, "/api/v1/auth/email", map[string]string{"email": "new@example.com"})
	require.Equal(t, 500, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"internal"`)
}
