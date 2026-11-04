# config

## Overview
Reads process environment into a `Config` struct and validates settings that `serve` needs.

## Interface
- `type Config struct`
- `func Load() (*Config, error)`
- `func (c *Config) ValidateServe() error`
- Variables read: `DATABASE_URL`, `PORT` (default `8080`), `BASE_URL` (default `http://localhost:8080`), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_AUTHORIZATION_URL`, `GITHUB_TOKEN_URL`, `GITHUB_INSTALLATION_URL`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_API_URL`, `GITHUB_APP_SLUG`, `RESEND_API_KEY`, `MAIL_FROM`, `TYPESAFE_API_KEY`, `TYPESAFE_API_URL`, `TYPESAFE_MODEL` (default `jev-latest`), `TYPESAFE_CONFIGURED`, `TRUSTED_PROXY_CIDRS`.

## Invariants
- [Load](config.go) requires `DATABASE_URL` and rejects malformed `TRUSTED_PROXY_CIDRS`, `/0` prefixes, and IPv4-mapped IPv6 prefixes. Accepted prefixes are masked. These checks affect every subcommand; the URL and mail rules below belong to `ValidateServe` only.
- `BASE_URL` must be an http or https origin with no user info, query, fragment or path other than `/`.
- `GITHUB_INSTALLATION_URL`, when set, must be an http or https URL with a host, no user info and no fragment.
- An https `BASE_URL` requires both `RESEND_API_KEY` and `MAIL_FROM`.
- `TypeSafeConfigured` is true when `TYPESAFE_API_KEY` is set or `TYPESAFE_CONFIGURED=true`.

## Side Effects
- Reads environment variables only.

## Verification
- Run: `cd api && go test ./internal/config/...`
