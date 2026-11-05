# activity

## Overview
Reads and renders the workspace activity log.

## Interface
- `useActivity(slug, filters?)` (`useActivity.ts`): TanStack infinite query over the workspace activity endpoint. Starts with a null cursor, forwards subsequent `cursor` values, and derives continuation from `next_cursor` (null ends pagination).
- `ActivityFilters` (`useActivity.ts`): optional `actor_id`, `verb`, `target_type`, and `target_id` strings, included in the query key and forwarded as nonempty query parameters.
- `ActivityRow({ activity })` (`ActivityRow.tsx`): one activity line.

## Invariants
- Query key is `['activity', slug, filters]`, so other features invalidate with the `['activity', slug]` prefix.

## Side Effects
- `api.get` network read only.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/activity`
