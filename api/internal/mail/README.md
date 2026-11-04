# mail

## Overview
Outbound email abstraction with a logging fallback and a Resend implementation.

## Interface
- `type Message struct`
- `type Mailer interface { Send(ctx, Message) error }`
- `type LogMailer`, `func NewLogMailer(log *slog.Logger) *LogMailer`
- `type Resend`, `func NewResend(apiKey, from string, httpClient *http.Client, baseURL string) *Resend`
- `func SignInMessage(to, link string) Message`
- `func InviteMessage(to, orgName, inviterName, link string) Message`

## Invariants
- Callers depend on `Mailer`, never a concrete sender.
- [NewResend and Send](resend.go) default to `https://api.resend.com`, but accept an override without enforcing HTTPS. Each send applies a two-second context timeout, including with a supplied HTTP client.

## Side Effects
- `LogMailer.Send` writes to the logger.
- `Resend.Send` posts JSON to the configured base URL's `/emails` endpoint.

## Verification
- Run: `cd api && go test ./internal/mail/...`
