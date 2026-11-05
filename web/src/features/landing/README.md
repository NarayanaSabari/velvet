# landing

## Overview
Public marketing landing page and the shared public page layout.

## Interface
- `LandingPage()` (`LandingPage.tsx`).
- `PublicPageLayout({ children, signingIn, title, expanded })` (`PublicPageLayout.tsx`).
- `landing.css` page styles.

## Invariants
- None

## Side Effects
- `PublicPageLayout` sets `document.title` to `${title} · Velvet` and restores the previous title on cleanup. Links to `/signin`.

## Verification
- Run: `cd web && pnpm run test`
