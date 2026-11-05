# comments

## Overview
Presentational comment thread and composer shared by issue and milestone pages.

## Interface
- `CommentComposer({ onSubmit, placeholder? })` (`CommentComposer.tsx`): requires `onSubmit(body)` for persistence.
- `CommentThread({ comments, onReply? })`, `ReplyEditor({ commentId, onReply })` (`CommentThread.tsx`): replies call `onReply(commentId, body)`, required by the editor but optional on the thread.

## Invariants
- Components do not fetch. Callers own persistence through the composer's `onSubmit` or the reply editor's `onReply` callback.

## Side Effects
- None.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/comments`
