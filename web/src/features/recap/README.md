# recap

## Overview
Personal work log recap at `/me/worklog`.

## Interface
- `Recap()` (`Recap.tsx`).

## Invariants
- Query key `['worklog', days]`, invalidated by `useStream`.

## Side Effects
- `api.get` work log. Markdown export link `/api/v1/me/worklog.md?days={days}`.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/recap`
