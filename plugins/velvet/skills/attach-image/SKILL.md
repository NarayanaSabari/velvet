---
name: attach-image
description: Save an important image to a Velvet ticket or milestone. Use when the user shares a screenshot, design reference, or result image and asks to keep it on a ticket or milestone, or when an image is clearly the evidence for a ticket being worked on.
---

# Attach an image to Velvet

The hosted Velvet server cannot read local files.
Uploading is two steps: get a single-use upload grant, then send the file bytes yourself.

## Before uploading

- Upload only images that matter to a specific ticket or milestone. Not every image in a conversation.
- You need the **actual file** on disk. If you can only see the image in the conversation and have no file path, ask the user for the file. Never claim an upload you did not make.
- Choose exactly one target: a ticket `key` or a `milestone_id`. If it is unclear, ask.
- Never upload unrelated or sensitive images, never scan directories for images, and never fetch arbitrary remote images.
- PNG, JPEG, and static WebP only, at most 10 MiB and 20 megapixels.

## 1. Prepare the grant

Call `velvet_prepare_image_upload` with:

- `key` or `milestone_id` (exactly one),
- `filename`: the file's name only, not a path,
- `caption`: one sentence on why the image matters, such as `The user's screenshot of the sign-in error that should stay visible.`

It returns JSON with `upload_url`, `upload_token`, `header_name`, `expires_at`, and `max_bytes`.
The grant works once and expires in 10 minutes.

## 2. Send the file

POST the file as multipart field `file`, with the token in the header the grant names.
Send **no** cookies and **no** `Authorization` header: the upload endpoint rejects both.

```bash
curl -fsS -X POST "$UPLOAD_URL" \
  -H "X-Velvet-Upload-Token: $UPLOAD_TOKEN" \
  -F "file=@/absolute/path/to/image.png"
```

Do not print, log, or store the upload token, and never put image bytes or base64 in the conversation.

A `201` means it was saved.
If the transfer was interrupted, check with `velvet_list_images` before retrying, because the first attempt may already have landed.

## 3. Confirm

Run `velvet_list_images` for the same target and tell the user the image is on the ticket or milestone.
Uploading an image never changes a ticket's status.

## Without a shell

If you cannot run commands, tell the user to run the Velvet CLI instead:

```bash
velvet upload-image ENG-42 /path/to/image.png --caption "Why this image matters"
```
