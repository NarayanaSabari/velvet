# auth

## Overview
Session cookie helpers shared by HTTP handlers.

## Interface
- `const CookieName = "ticket_session"`
- `const SessionTTL = store.SessionTTL` (30 days)
- `func SetSessionCookie(w http.ResponseWriter, token string, secure bool)`
- `func ClearSessionCookie(w http.ResponseWriter, secure bool)`

## Invariants
- Cookie lifetime follows `store.SessionTTL`, so server and browser expiry agree.
- Both helpers set `Path=/`, `HttpOnly=true`, `SameSite=Lax`, and the supplied `Secure` flag. Clearing sets an empty value and `MaxAge=-1` without an `Expires` value. See [session.go](session.go).

## Side Effects
- Writes `Set-Cookie` headers.

## Verification
- Run: `cd api && go test ./internal/auth/...`
