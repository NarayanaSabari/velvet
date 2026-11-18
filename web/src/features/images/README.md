# images

## Overview
Image attachments for issues and milestones.

## Interface
- `ImagesSection({ slug, target, targetId })`, `ImageAttachment` (`ImagesSection.tsx`). Lists only images not attached to a comment.
- `CommentImages({ images, slug })` (`CommentImages.tsx`): thumbnails under a comment, linking to the full image.
- `uploadCommentImages(slug, target, targetId, commentId, files)` (`uploadCommentImages.ts`): multipart upload with `comment_id`; caption is the file name.
- `protectedImageUrl(value, slug, id, kind)` (`protectedImageUrl.ts`).

## Invariants
- `target` is `'issues' | 'milestones'`.
- `protectedImageUrl` validates an existing URL, without constructing or normalizing it. Only ASCII letters, digits, `_`, and `-` are allowed in slug/ID. The value must exactly equal `/api/v1/w/{slug}/images/{id}/content`, with `?download=1` only for download kind; otherwise it returns `null`.
- Query key is `['images', slug, target, targetId]`. Only admins or members who uploaded an image receive deletion controls.

## Side Effects
- `api.get` list, `api.del` delete, invalidates `['activity', slug]`.
- Successful deletion immediately removes the image from the cached response, then invalidates that image query.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/images src/features/comments`
