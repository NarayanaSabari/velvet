---
name: attach-image
description: Save an important image to a Velvet ticket or milestone with `velvet upload-image`. Use when the user shares a screenshot, design reference, or result image and asks to keep it on a ticket or milestone, or when an image is clearly the evidence for a ticket being worked on.
---

# Attach an image to Velvet

## Before uploading

- Upload only images that matter to a specific ticket or milestone. Not every image in a conversation.
- You need the **actual file** on disk. If you can only see the image in the conversation and have no file path, ask the user for the file. Never claim an upload you did not make.
- Choose exactly one target: a ticket key or a milestone id. If it is unclear, ask.
- Never upload unrelated or sensitive images, never scan directories for images, and never fetch arbitrary remote images.
- PNG, JPEG, and static WebP only, at most 10 MiB and 20 megapixels.

## Upload

Run `velvet upload-image` with one target, the file, and a caption:

```bash
velvet upload-image ENG-42 /absolute/path/to/image.png --caption "The user's screenshot of the sign-in error that should stay visible."
velvet upload-image --milestone MILESTONE_ID /absolute/path/to/design.webp --caption "Accepted layout for this goal."
```

The caption is one sentence on why the image matters.
The file is sent straight from disk, so never put image bytes or base64 in the conversation.

It prints `Uploaded image ... Status unchanged.` on success.
Uploading the same file with the same caption again reuses the first upload, so a retry after an interrupted transfer is safe.
Exit code 6 with "valid PNG, JPEG or WebP" means the file is not a supported image.

Tell the user the image is on the ticket or milestone.
Uploading an image never changes a ticket's status.

## Inspect and remove

`velvet images ENG-42` lists that ticket's image metadata and IDs.
`velvet images --milestone MILESTONE_ID` lists a milestone's images.
These commands list metadata, not image bytes or local downloads.
`velvet image IMAGE_ID delete --yes` removes one attachment after the user explicitly requests deletion.
Check the target and image ID first. Never delete an image as routine cleanup.
The server still requires uploader ownership with write access, or an admin role.
Deletion never changes ticket status.
