# issues

## Overview
Issue list, filters, creation, and the issue detail page with timeline, metadata rail, and evidence.

## Interface
- `IssuesPage({ slug })` (`IssuesPage.tsx`), `IssueList` (`IssueList.tsx`).
- `IssuePage({ slug, issueKey })`, `IssuePageLayout`, `IssueTimeline`, `IssueEvidenceSection` (`IssuePage.tsx`).
- `IssueMetadata`, `ReadOnlyIssueMetadata`, `Choice`, `IssueMetadataPatch` (`IssueMetadata.tsx`).
- `IssueLabels` (`IssueLabels.tsx`), `StatusSelect`, `StatusDot` (`StatusSelect.tsx`).
- `buildTimeline`, `TimelineEntry` (`issueTimeline.ts`).

## Invariants
- Query keys: `['issues', slug, ...]`, `['issue', slug, issueKey]`, `['comments', slug, 'issue', issueKey]`, `['evidence', slug, issueKey]`.
- `IssuePageLayout` keeps narrative before the metadata rail (see `design.md`).
- List requests use 50-row cursor pages with server counts (`include_counts=true`). Filter changes reset cursor history. Only URL `status=open` initializes status, expanding to every status except `done` and `cancelled`; other URL status values do not initialize it. `project=unfiled` becomes `unfiled=true` (`IssuesPage.tsx`).

## Side Effects
- `api.get/post/patch/put` for issues, comments, and metadata.
- Detail issue/comment/metadata mutations refresh their related queries, including issues and activity. Exceptions: list-page issue creation invalidates only `['issues', slug]`; label creation invalidates only `['labels', slug]` (`IssuesPage.tsx`, `IssuePage.tsx`).
- Initial `status` and `project` filters are read from `window.location.search`.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/issues`
