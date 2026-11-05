# profile

## Overview
Personal settings: profile, GitHub identities, API tokens, and agent configuration.

## Interface
- `ProfileRoute`, `Profile({ slug, page })`, `GitHubProfile`, `ApiTokens` (`Profile.tsx`).
- `PROFILE_PAGES`, `ProfilePageId` (`profilePages.ts`).
- `ApiToken`, `CreatedApiToken`, `apiTokensQuery` (`apiTokens.ts`).
- `OrganisationGitHubIdentity`, `organisationGitHubQuery(slug)` (`organisationGitHub.ts`).
- `GitHubAccountsTable` (`GitHubAccountsTable.tsx`), `AgentConfig({ workspace })` (`AgentConfig.tsx`).

## Invariants
- Query keys `['api-tokens']`, `['me', 'github', slug]`.
- Created API tokens remain in component state for one-time display, not the token-list cache. Section content is keyed by page and remounts on section change; `ProfileRoute` keys the profile by workspace slug to reset private state on workspace change (`Profile.tsx`).

## Side Effects
- `api.post` / `api.del` create and revoke API tokens and unlink GitHub accounts.
- GitHub linking uses `/api/v1/auth/github/link` and `/api/v1/w/{slug}/me/github/link`.
- Token copying writes to the clipboard, with a legacy textarea/`execCommand('copy')` fallback. Revocation invalidates both API-token and onboarding queries (`Profile.tsx`).
- GitHub linking clears private caches before full-page navigation. Removing a GitHub account refreshes private queries globally (`GitHubAccountsTable.tsx`).

## Verification
- Run: `cd web && pnpm exec vitest run src/features/profile`
