# work

## Overview
Shared create and edit forms for sprints, milestones, and issues, plus project/milestone link helpers.

## Interface
- `SprintForm`, `SprintInput`, `MilestoneForm`, `MilestoneEditForm`, `MilestoneInput`, `MilestoneOptions`, `IssueForm`, `IssueEditForm`, `IssueInput`, `IssueLinkChoices` (`CoreForms.tsx`).
- `ProjectChoice`, `MilestoneChoice`, `projectChoices`, `milestoneChoices`, `groupChoices`, `reconcileLinks`, `membersQuery`, `projectsQuery`, `sprintsQuery`, `useWorkLinks` (`workLinks.ts`).

## Invariants
- Forms do not persist. Callers own writes through `onSubmit`.
- Query keys `['members', slug]`, `['projects', slug, true]`, `['sprints', slug]`, `['milestones', slug, 'all']`.
- `projectChoices` retains the currently assigned project even when archived. `milestoneChoices` excludes completed-sprint milestones except the current selection. `reconcileLinks` follows a selected milestone's project and clears an incompatible milestone when the project changes (`workLinks.ts`).
- The shared member cache retains the `{ members: User[] }` response envelope. Consumers may select the array without changing the cached shape (`membersQuery`).

## Side Effects
- `api.get` reads in `workLinks.ts` only.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/work`
