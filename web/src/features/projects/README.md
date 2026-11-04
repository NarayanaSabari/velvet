# projects

## Overview
Workspace project list with create and archive.

## Interface
- `ProjectsPage({ slug })` (`ProjectsPage.tsx`).

## Invariants
- Query key `['projects', slug, includeArchived]`.

## Side Effects
- `api.get/post/patch`, invalidates `['projects', slug]`.

## Verification
- Run: `cd web && npx vitest run src/features/projects`
