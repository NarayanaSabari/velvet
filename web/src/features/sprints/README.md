# sprints

## Overview
Sprint list, sprint board with milestones, kanban status moves, and sprint close.

## Interface
- `SprintList({ slug })` (`SprintList.tsx`).
- `SprintBoard({ slug, sprintId })`, `SprintIssue`, `SprintMilestone`, `MilestoneCard`, `MilestoneRow`, `MilestoneCardProps`, `IssueGroups`, `IssueGroupsProps`, `CloseSprintAction`, `MilestoneEmptyState` (`SprintBoard.tsx`).
- `SprintKanban`, `StatusMove`, `MoveToast` (`SprintKanban.tsx`).
- `issuesForSprint` (`sprintIssues.ts`).

## Invariants
- Query keys `['sprint', slug, sprintId]`, `['sprints', slug]`, `['milestones', slug, sprintId]`, `['issues', slug, { sprint_id }]`, `['issues', slug, { milestone_id: null }]`.
- `issuesForSprint` returns sprint issues unchanged unless active. Active sprints merge milestone-free workspace issues, restricted to the sprint project when supplied and deduplicated by issue ID. The workspace query walks every issue page; the sprint-specific request is capped at 200 (`sprintIssues.ts`, `SprintBoard.tsx`).
- `?view=board` persists through `history.replaceState`; widths below 640px use the list even with that preference. Status moves cancel both issue queries, snapshot and optimistically update their caches, restore snapshots on error, and provide Undo feedback (`SprintBoard.tsx`, `SprintKanban.tsx`).

## Side Effects
- `api.get/post/patch` for sprints, milestones, and issue status. Invalidates `['issues', slug]` and `['sprints', slug]`. `SprintList` navigates to `/w/{slug}/sprints/{id}`, and `SprintBoard` opens issues at `/w/{slug}/issues/{key}`.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/sprints`
