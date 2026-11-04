# imageupload

## Overview
Validates and sanitizes uploaded images before storage.

## Interface
- `const MaxBytes = 10 << 20`, `const MaxPixels = 20_000_000`
- `type Image struct { Data []byte; ContentType string; Width, Height int }`
- `func Sanitize(data []byte) (Image, error)`
- `func SanitizeContext(ctx context.Context, data []byte) (Image, error)`
- `var ErrInvalid`, `var ErrLimit`, `var ErrBusy`

## Invariants
- Accepts PNG, JPEG or WebP only.
- [Sanitization](image.go) rejects animated PNG chunks and WebP `ANIM`/`ANMF` with `ErrInvalid`. WebP requires exactly one frame and matching canvas/frame dimensions.
- Rejects input over 10 MiB or 20 megapixels.
- At most 2 decodes run at once (`decodeSlots`).
- EXIF is replaced with only its orientation tag.

## Side Effects
- CPU-bound decoding. No disk or network access.

## Verification
- Run: `cd api && go test ./internal/imageupload/...`
