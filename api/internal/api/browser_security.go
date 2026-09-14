package api

import (
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

func (s *Server) browserMutations(next http.Handler) http.Handler {
	origin := canonicalOrigin(s.cfg.BaseURL, true)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/webhooks/github" || r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if origin == "" || canonicalOrigin(r.Header.Get("Origin"), false) != origin || len(r.Header.Values("Origin")) != 1 {
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

// canonicalOrigin follows URL origin semantics for the two HTTP schemes this
// server accepts. The configured BASE_URL may carry a root path or an explicit
// default port; browser Origin headers carry neither.
func canonicalOrigin(raw string, allowRootPath bool) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return ""
	}
	if u.RawPath != "" || (u.Path != "" && (!allowRootPath || u.Path != "/")) {
		return ""
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.Contains(host, "%") {
		return ""
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		host = addr.String()
	} else if strings.Contains(host, ":") {
		return ""
	}

	port := u.Port()
	if port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil {
			return ""
		}
		if (scheme == "http" && number == 80) || (scheme == "https" && number == 443) {
			port = ""
		} else {
			port = strconv.FormatUint(number, 10)
		}
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host
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
