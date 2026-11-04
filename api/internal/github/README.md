# github

## Overview
GitHub App and GitHub user OAuth clients.

## Interface
- `type Client`, `func NewClient(appID string, privateKeyPEM []byte, baseURL string) (*Client, error)`
- `(*Client).InstallationToken`, `ListPullRequests`, `GetPullRequest`, `GetPullRequestConditional`, `ListReviews`, `InstallationSuspended`, `ListInstallationRepositories`
- `type Repository`, `type PullRequest`, `type Review`, `func NormalizeState(apiState string, mergedAt *time.Time) string`
- `type UserClient`, `type UserClientConfig`, `func NewUserClient(cfg UserClientConfig) (*UserClient, error)`
- `(*UserClient).AuthorizationURL(state, challenge)`, `(*UserClient).Authorize(ctx, code, verifier, candidate)`
- `type AuthorizedUser`, `type VerifiedInstallation`, `type UserAuthorization`
- Errors: `ErrRateLimited`, `RateLimitError`, `APIError`, `ErrInstallationRepositories`, `ErrUserAuthorization`

## Invariants
- Most App calls exchange an App JWT for a cached installation token. [InstallationSuspended](installation.go) sends the App JWT directly because suspended installations cannot mint installation tokens.
- `RateLimitError` matches `ErrRateLimited` through `errors.Is`.
- [User authorization](user_auth.go) uses PKCE. Candidate `0` returns identity only, skipping installation verification. A personal installation requires a matching account ID; an organisation installation requires active organisation-admin membership. Merely seeing the installation is insufficient.

## Side Effects
- Network calls to the GitHub REST API and OAuth endpoints.
- In-memory installation token cache.

## Verification
- Run: `cd api && go test ./internal/github/...`
