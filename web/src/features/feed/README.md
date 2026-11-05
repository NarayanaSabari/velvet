# feed

## Overview
Team activity feed page.

## Interface
- `TeamFeed({ slug })` (`TeamFeed.tsx`).

## Invariants
- None

## Side Effects
- Reads activity through `useActivity` (`../activity/useActivity.ts`) and session through `useSession`.

## Verification
- Run: `cd web && pnpm run test`
