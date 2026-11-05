# orgs

## Overview
Create and leave organisations (workspaces).

## Interface
- `NewOrganisation({ navigate, publicLayout })` (`NewOrganisation.tsx`).
- `LeaveOrganisation` (`LeaveOrganisation.tsx`).

## Invariants
- Both take an injectable `navigate` for tests.

## Side Effects
- `api.get` `['session']` and `['my-invites']`, `api.post` `/orgs`, `/me/invites/{id}/accept`, or `/w/{slug}/leave`. Creation and invitation acceptance clear private caches before entering `/w/{slug}`. Leaving also runs `clearPrivateQueries` before navigation to `/`. Invitation acceptance HTTP 410 navigates to `/expired` (`NewOrganisation.tsx`).

## Verification
- Run: `cd web && pnpm run test`
