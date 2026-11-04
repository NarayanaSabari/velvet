# admin

## Overview
Workspace administration pages: general settings, members, invitations, repositories, danger zone, and suggestion settings.

## Interface
- `Admin({ slug, page })`, `AdminLayout` (`Admin.tsx`, `AdminLayout.tsx`).
- `AdminPageId`, `AdminPage`, `ADMIN_PAGES`, `ADMIN_PAGE_IDS`, `useAdminData(slug, enabled)` (`adminPages.ts`).
- Panels: `OrganisationPanel`, `MembersPanel`, `InvitePanel`, `GitHubPanel`, `SuggestionsPanel`, `DangerPanel`.
- `ROLES`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS`, `expiresSoon(expiresAt, now)` (`roles.ts`).

## Invariants
- `AdminPageId` is limited to `general | members | invitations | repositories | danger`.
- Roles are exactly `admin`, `member`, `viewer` (`roles.ts:ROLES`).
- `DangerPanel` takes an injectable `navigate` (default `navigateTo`) for testability.
- `AdminLayout` enables admin queries only for admin membership and never invokes page children without it.
- Workspace deletion requires confirmation text exactly matching the slug before the form submits.

## Side Effects
- `api.get/post/patch/put/del` against workspace admin endpoints.
- Invalidates `['memberships', slug]`, `['invites', slug]`, `['repos', slug]`, `['suggested-notes', slug]`, `['unlinked', slug]`.
- `GitHubPanel` links to `/api/v1/w/${slug}/github/connect`.
- `DangerPanel` deletes the workspace and navigates away.
- Organisation updates and membership changes refresh private queries globally. Self-removal and workspace deletion clear private caches before navigating to `/`.
- GitHub connection polling runs every two seconds while `syncing`, or while `suspended` without an error; it stops in other states (`GitHubPanel.tsx`).

## Verification
- Run: `cd web && npx vitest run src/features/admin`
