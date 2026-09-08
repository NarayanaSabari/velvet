package api_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

// Mutations must not accept browser CSRF, including bodyless logout and DELETE.
func TestBrowserMutationsRequireSameOriginJSON(t *testing.T) {
	f := testutil.NewFixture(t)
	for _, tc := range []struct {
		origin, contentType string
		want                int
	}{
		{"https://evil.example", "application/json", 403},
		{"", "application/json", 403},
		{"null", "application/json", 403},
		{"http://localhost:8080", "text/plain", 415},
		{"http://localhost:8080", "", 415},
		{"http://localhost:8080", "application/json; charset=utf-8", 200},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Content-Type", tc.contentType)
		rec := httptest.NewRecorder()
		f.Handler.ServeHTTP(rec, req)
		require.Equal(t, tc.want, rec.Code, "origin=%q content-type=%q", tc.origin, tc.contentType)
		if tc.want != 200 {
			require.Empty(t, rec.Result().Cookies())
		}
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		req := httptest.NewRequest(method, "/api/v1/w/lab/issues", nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		f.Handler.ServeHTTP(rec, req)
		require.Equal(t, 403, rec.Code)
	}
}

func TestMagicWrongOriginDoesNotConsume(t *testing.T) {
	f := testutil.NewFixture(t)
	token, err := f.Store.IssueLoginToken(t.Context(), "new@example.com", "127.0.0.1", nil)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/magic", bytes.NewBufferString(`{"token":"`+token+`"}`))
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	require.Equal(t, 403, rec.Code)
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM login_token WHERE consumed_at IS NOT NULL`).Scan(&n))
	require.Zero(t, n)
}

// Request-IP counters use the actual peer unless every hop to a forwarded IP is trusted.
func TestEmailClientIPTrustsOnlyExplicitProxyChain(t *testing.T) {
	for _, tc := range []struct{ name, peer, xff, want string }{
		{"direct spoof", "192.0.2.40:3456", "203.0.113.10", "192.0.2.40"},
		{"trusted proxy", "172.30.75.2:3456", "203.0.113.10", "203.0.113.10"},
		{"untrusted intermediary", "172.30.75.2:3456", "198.51.100.5, 203.0.113.10", "203.0.113.10"},
		{"multiple trusted hops", "172.30.75.2:3456", "198.51.100.5, 172.30.75.3", "198.51.100.5"},
		{"malformed nearest hop", "172.30.75.2:3456", "198.51.100.5, junk", "172.30.75.2"},
		{"mapped IPv4", "[::ffff:192.0.2.40]:3456", "198.51.100.5", "192.0.2.40"},
		{"IPv6", "[2001:0db8:0:0::1]:3456", "198.51.100.5", "2001:db8::1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := testutil.NewFixture(t)
			cfg := &config.Config{BaseURL: "http://localhost:8080", TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("172.30.75.2/32"), netip.MustParsePrefix("172.30.75.3/32")}}
			h := api.NewServer(f.Pool, cfg, api.Dependencies{Mailer: &recordingMailer{}}).Handler()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/email", bytes.NewBufferString(`{"email":"new@example.com"}`))
			req.RemoteAddr = tc.peer
			req.Header.Set("Origin", cfg.BaseURL)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Forwarded-For", tc.xff)
			req.Header.Set("X-Real-IP", "192.0.2.99")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, 202, rec.Code, rec.Body.String())
			var ip string
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT request_ip::text FROM login_token`).Scan(&ip))
			require.Equal(t, tc.want, ip)
		})
	}
}
