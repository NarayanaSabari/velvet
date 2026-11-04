# reports

## Overview
Workspace reports: person activity, milestone completion, closed per sprint, and stale issues.

## Interface
- `Reports({ slug })`, `PersonActivityTable`, `MilestoneCompletionTable`, `ClosedPerSprintTable`, `StaleTable` (`Reports.tsx`).

## Invariants
- Activity, milestone, and closed report keys are `['reports', slug, 'activity' | 'milestones' | 'closed']`. Stale uses the four-element key `['reports', slug, 'stale', STALE_DAYS]`, where `STALE_DAYS = 14` (`Reports.tsx`).

## Side Effects
- `api.get` only.

## Verification
- Run: `cd web && npx vitest run src/features/reports`
