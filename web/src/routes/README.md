# routes

## Overview
TanStack Router tree mapping public and workspace paths to feature components.

## Interface
- `createAppRouter(history?, client?)`, `router` (`router.tsx`).
- `RootLayout`, `RootNotFound` (`root.tsx`).
- `productPageTitle(pathname)` (`productTitle.ts`).

## Invariants
- Workspace routes live under `/w/$slug/...` (feed, sprints, milestones, issues, projects, reports, unlinked, admin, mentions, settings/profile).
- Public routes include `/signin`, `/signin/confirm`, `/check-email`, `/expired`, `/invite`, `/auth/recovery`, `/cli/approve`, `/orgs/new`, `/onboarding`, `/not-invited`. `/me/worklog` is the personal recap.

## Side Effects
- `/` `beforeLoad` fetches the session (`sessionQueryOptions`, `staleTime: 0`) through the router context `queryClient`.
- `/not-invited` redirects to `/signin`.
- Bare administration redirects to `/w/{slug}/admin/general`. Bare profile redirects to General, or Agent config for the legacy `#agent-config` fragment, preserving its query string. Unknown admin/profile section IDs throw not-found (`router.tsx`).
- `RootLayout` uses the workspace shell for product paths and the public outlet otherwise. It updates product-path `document.title` using `productPageTitle` (`root.tsx`).

## Verification
- Run: `cd web && npx vitest run src/routes`
