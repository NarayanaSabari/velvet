# auth

## Overview
Public sign-in, magic-link confirmation, invitation acceptance, CLI approval, recovery, and session state.

## Interface
- Pages: `SignIn`, `ConfirmSignIn`, `CheckEmail`, `Expired`, `Invite`, `ApproveCLI`, `PublicAuthPage`, `PublicSessionPending`, `PublicSessionError`, `PublicRecovery`, `SignOutButton`.
- `useSession(slug?)`, `Session`, `sessionQueryOptions(client)`, `landingWorkspace(session)` (`useSession.ts`).
- `navigateTo`, `cliReturnTo`, `safeSignInNext`, `clearPrivateQueries`, `refreshPrivateQueries`, `fragmentToken`, `clearFragment` (`sessionNavigation.ts`).

## Invariants
- Session query key is `['session']`.
- `safeSignInNext` sanitizes post-sign-in redirects. Redirect targets must pass through it.
- Tokens arrive in the URL fragment (`fragmentToken`) and are cleared with `clearFragment`.
- `SignIn`, `ConfirmSignIn`, and `Invite` accept injectable `navigate` props defaulting to `navigateTo` (`window.location.assign`). This is not a universal page interface: `ApproveCLI`, `CheckEmail`, `Expired`, and public recovery components expose no such prop.
- CLI consent distinguishes `login`, `manage`, and `desktop` (approval sends no workspace/project scope) from legacy `init` or absent flow (fetches projects and submits workspace/project selection). Users can deny requests. A deadline-driven timer disables approval on expiration (`ApproveCLI.tsx`).
- Session reads use a 60-second stale time and no retries. Only HTTP 401 becomes signed-out state; other failures propagate. When a previously cached user identity changes or signs out, the session query cancels and removes non-session queries and clears mutation state (`useSession.ts`).

## Side Effects
- `api.post` for sign-in, confirm, invite accept, CLI approval, and sign-out.
- Full-page navigation via `window.location`.
- `clearPrivateQueries` / `refreshPrivateQueries` reset the query cache on session change.

## Verification
- Run: `cd web && pnpm exec vitest run src/features/auth`
