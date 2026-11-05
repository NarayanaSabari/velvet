# mentions

## Overview
Inbox of mentions for the current user in a workspace.

## Interface
- `Mentions({ slug })` (`Mentions.tsx`).

## Invariants
- Query key `['mentions', slug]`.

## Side Effects
- `api.get` mentions, `api.post` `/w/{slug}/mentions/read`, invalidates `['dashboard', slug]`.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/mentions`
