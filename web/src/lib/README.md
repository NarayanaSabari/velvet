# lib

## Overview
Shared API client, query client, domain types, and live update stream.

## Interface
- `api.get/post/patch/put/del`, `ApiError`, `isNotFound`, `listAllWorkspaceIssues` (`api.ts`).
- `queryClient` (`query.ts`).
- Domain types such as `Issue`, `IssueStatus`, `Milestone`, `Sprint`, `Role`, `Membership`, `SessionPayload`, `Evidence` (`types.ts`).
- `useStream(slug)` (`useStream.ts`), `userLabel` (`userLabel.ts`).

## Invariants
- All requests go to base `/api/v1` with `credentials: 'same-origin'`. The SPA never holds a session token.
- Non-OK responses throw `ApiError(status, code, message)`, even when the body is not JSON. `204` returns `undefined`.
- `queryClient` uses `staleTime: 30_000` and never retries 4xx `ApiError`s (max 2 retries otherwise).
- `listAllWorkspaceIssues` walks every cursor page (`limit=200`).
- `useStream` invalidates caches instead of patching them. Workspace keys must put `slug` at index 1.

## Side Effects
- `fetch` to `/api/v1`.
- `useStream` opens `EventSource('/api/v1/w/{slug}/stream')` and listens to `activity`, `refresh`, `open`, and window `online`.

## Verification
- Run: `cd web && pnpm exec vitest run src/lib`
