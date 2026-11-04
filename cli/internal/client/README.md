# client

## Overview
Package `client` is the CLI's authenticated API client for one Velvet server. Self-update instead uses `cmd/velvet/update.go:downloadClient` and `fetch`: an unauthenticated download client with a two-minute timeout and Go's default redirect policy, not this client's credential-safe no-redirect policy.

## Interface
- `client.go:Client` with fields `Base`, `Token`, `HTTP`, `UserAgent`.
- `client.go:New(base, token, version)` builds a client for a server URL without `/api/v1`.
- `client.go:Client.Do(method, path, query, body, out)` sends JSON and decodes a JSON answer.
- `client.go:Client.Text(path, query)` returns a raw body, for Markdown endpoints.
- `client.go:Client.Upload(path, file, caption, out)` posts one file as multipart field `file` with a `caption` field.
- `client.go:Error` is a non-2xx answer with `Status`, `Code`, `Message`.
- `client.go:StatusOf(err)` returns an `Error`'s HTTP status, or 0.

## Invariants
- `New` sets `CheckRedirect` to `http.ErrUseLastResponse`, so redirects are never followed with credentials.
- `New` sets a 30 second HTTP timeout and `User-Agent: velvet-cli/<version>`.
- All paths are prefixed with `/api/v1` by `Client.url`.
- `Authorization: Bearer <token>` is sent only when `Token` is non-empty (`send`).
- Response bodies are read up to 8 MiB (`send`). Uploads copy at most 10 MiB + 1 byte so the server can reject oversize files (`Upload`).
- Non-2xx statuses and HTTP 202 become `*Error` decoded from the `{"error":{"code","message"}}` envelope (`send`).

## Side Effects
- Network requests to the configured Velvet server.
- `Upload` opens and reads a local file.

## Verification
- Run: `go test ./internal/client/...` from `cli/`.
