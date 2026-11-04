# milestones

## Overview
Milestone detail page with its issues, comments, and metadata.

## Interface
- `MilestonePage({ slug, milestoneId })`, `MilestonePageLayout({ main, sidebar })` (`MilestonePage.tsx`).

## Invariants
- Query keys `['milestone', slug, milestoneId]`, `['comments', slug, 'milestone', milestoneId]`, `['issues', slug, { milestone_id }]`.

## Side Effects
- `api.get/post/patch` for milestone, comments, and edits.
- Sets `document.title` to `${milestone.name} · Velvet` when the milestone loads (`MilestonePage.tsx`).
- Invalidates `['activity', slug]`, `['issues', slug]`, `['milestones', slug]`. Navigates to `/w/{slug}/issues/{key}` after issue create or open.

## Verification
- Run: `cd web && npx vitest run src/features/milestones`
