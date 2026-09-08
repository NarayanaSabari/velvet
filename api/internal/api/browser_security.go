package api

import (
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

func (s *Server) browserMutations(next http.Handler) http.Handler {
	base, _ := url.Parse(s.cfg.BaseURL)
	origin := ""
	if base != nil && base.Scheme != "" && base.Host != "" {
		origin = base.Scheme + "://" + base.Host
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/webhooks/github" || r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if origin == "" || r.Header.Get("Origin") != origin || len(r.Header.Values("Origin")) != 1 {
			WriteError(w, http.StatusForbidden, "forbidden", "same-origin request required")
			return
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			WriteError(w, http.StatusUnsupportedMediaType, "invalid_request", "application/json is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP walks X-Forwarded-For from the socket peer toward the client. Each
// hop must be explicitly trusted before its supplied predecessor is used.
func (s *Server) clientIP(r *http.Request) (string, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "", err
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return "", err
	}
	addr = addr.Unmap()
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		trusted := false
		for _, prefix := range s.cfg.TrustedProxyCIDRs {
			if prefix.Contains(addr) {
				trusted = true
				break
			}
		}
		if !trusted {
			break
		}
		previous, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		addr = previous.Unmap()
	}
	return addr.String(), nil
}
