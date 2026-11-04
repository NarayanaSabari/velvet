# evidence

## Overview
Pull request evidence cards, link suggestions, and the unlinked pull request queue.

## Interface
- `EvidenceCard({ pr, issueStatus, onMarkDone? })` (`EvidenceCard.tsx`): requires the PR and issue status. Offers the optional explicit mark-done callback only for merged PRs on issues whose status is neither `done` nor `cancelled`.
- `SuggestionLine` (`SuggestionLine.tsx`).
- `UnlinkedPRs({ slug })` (`UnlinkedPRs.tsx`).
- `pullRequestStateLabel` (`pullRequestState.ts`).

## Invariants
- Query keys `['unlinked', slug]` and `['suggested-notes', slug]`.
- Linking evidence never changes issue status (see repository `AGENTS.md`).

## Side Effects
- `api.get` unlinked PRs and suggestions, `api.post` link or dismiss actions.
- Invalidates `['activity', slug]`.
- `SuggestionLine` treats HTTP 409 as already handled elsewhere: refreshes caller-supplied query keys and activity instead of showing a new error. Other mutation errors remain visible. Successful accept/dismiss uses the same refresh path.

## Verification
- Run: `cd web && npx vitest run src/features/evidence`
