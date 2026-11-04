# palette

## Overview
Keyboard command palette for navigation and quick issue creation.

## Interface
- `CommandPalette` (`CommandPalette.tsx`).
- `COMMAND_PALETTE_TEST_IDS` (`paletteTestIds.ts`).

## Invariants
- Test IDs come from `COMMAND_PALETTE_TEST_IDS`, shared by `CommandPalette.tsx`, `app/Shell.tsx`, and the palette unit test.

## Side Effects
- `api.post` to `/w/{slug}/issues` for quick create, plus navigation commands through the injected `navigate`.
- Quick creation fetches workspace milestones directly. While open, nonempty searches that are not issue keys wait 150 ms, then call `listAllWorkspaceIssues` to fetch every cursor page (200 rows per request, not one bounded result page). These reads bypass TanStack Query. Failed reads clear milestone/search results instead of showing a query error (`CommandPalette.tsx`, `../../lib/api.ts`).

## Verification
- Run: `cd web && npx vitest run src/features/palette`
