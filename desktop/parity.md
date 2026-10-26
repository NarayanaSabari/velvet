# Desktop parity and verification

Snapshot: October 26, 2026. This is a first native preview slice, not full web-feature parity.

## Implemented slice

- Rust/GPUI Apple Silicon application, native issue list/detail and read-only `--demo` data.
- Browser-approved desktop authentication, dedicated desktop credentials, macOS Keychain storage and revocation.
- Organisation/project selection, search over loaded issues, status filters, refresh and pagination.
- Issue creation, title/description editing, explicit status changes and human-attributed progress comments.
- Keyboard commands, modal focus handling, in-memory context-isolated drafts and draft-safe Quit confirmation.
- Light/dark appearance and narrow-window layout. Other workflows explicitly open the web app.
- Locked dependencies, local ad-hoc app packaging and a separate read-only macOS check workflow.

## Verified evidence

- Final formatting and locked all-target Cargo checking passed.
- Final serial suite with `--features ui-tests` passed: 22 binary tests, 12 client integration tests and 11 contract tests. Some contract tests repeat across targets, so these are not unique test counts.
- Seven native UI tests cover issue selection, filters, workspace-isolated drafts, modal forward/backward Tab focus, Escape, blocked background mutations and saving/Quit guards.
- A separate real macOS Keychain round trip passed using a disposable account and removed its credential afterward.
- Real browser consent and the Rust client passed against the disposable API stack: desktop token polling, identity, issue changes, human-attributed progress comments and revocation. Test fixtures were removed.
- Five actual Metal-rendered screenshots captured desktop light/dark, narrow layout, commands and Quit confirmation under ignored `desktop/target/screenshots/`. Reviewed layouts were readable and contained.
- Final release packaging, plist validation and strict ad-hoc signature verification passed. Existing package output is protected against overwrite.
- The final packaged Apple Silicon app launched. Native checks verified issue navigation, new-issue draft retention, Quit confirmation, cancellation preserving the exact draft and clean process exit after clearing the test draft.
- API and web regression suites, web build and lint passed during desktop-auth integration.

These checks exercise native sample-mode UI and real-server browser/client integration separately. They do not establish complete packaged GUI-to-server acceptance.

## Remaining acceptance boundaries

- Full packaged native GUI-to-real-server acceptance, restored credentials and all failure states remain unverified.
- Full VoiceOver acceptance remains unverified. The native accessibility tree sometimes stayed stale until window resize.
- Optional DMG creation, mounting and manual installation were not performed.
- Production sign-in requires deployment of the dedicated desktop-auth backend changes. No deployment or public release was performed.
- Unused model-field warnings and an upstream `block` future-compatibility warning remain.
- Work-log recording was blocked: `velvet whoami` exited 3 because the CLI was not signed in. No successful log is claimed.

## Build environment

Verified on macOS 26.4.1 arm64 with Rust/Cargo 1.97.1 in `~/.cargo/bin` and Apple Command Line Tools. GPUI kit is pinned to 0.7.0 with runtime shaders, so this configuration does not require full Xcode or the offline Metal compiler. The generated `desktop/dist/Velvet Preview.app` is a local ad-hoc-signed preview, not a notarized distribution.

## Deliberately outside the first slice

- Offline database, offline writes, durable queues and conflict resolution.
- Automatic updates, Intel/universal packages and other operating systems.
- Developer ID signing, notarization, stapling and trusted clean-machine distribution.
- Full native dashboard/feed, sprint planning, milestones, mentions, image attachments, GitHub evidence, reports, profile and administration.
- Production deployment and public release. Builds, commits and local verification do not authorize either.

Issue statuses never change automatically because a branch, commit, PR, package or deployment exists. The web application remains the reference for workflows not yet implemented natively.
