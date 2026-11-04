# app

## Overview
Shared workspace shell and responsive navigation.

## Interface
- `Shell({ children, slug?, navigate? })` (`Shell.tsx`): optional workspace slug and injectable navigation callback.
- `NavLink`, `NavLinkProps`, `NavLinkProvider` (`nav.tsx`).

## Invariants
- Desktop sidebar and mobile bottom navigation follow `design.md`.
- Reads session state before rendering children: loading suppresses children, signed-out users see sign-in, and inaccessible workspaces show an access error. Signed-in users without memberships and without a slug see onboarding.

## Side Effects
- Reads `window.location` for active navigation. Links to `/me/worklog` and `/orgs/new`.
- Starts workspace SSE through `useStream` only for a signed-in session with an accessible workspace and a supplied slug.

## Verification
- Run: `cd web && npx vitest run src/app`
