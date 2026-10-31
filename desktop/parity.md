# Desktop parity and verification

Feature inventory reviewed October 31, 2026. This is an online-first native preview, not full web-feature parity. Historical acceptance evidence below applies to the named build and date, not automatically to later source changes.

## Implemented slice

- Rust/GPUI Apple Silicon application, native issue list/detail and read-only `--demo` data.
- Browser-approved desktop authentication, dedicated desktop credentials, macOS Keychain storage and revocation.
- Organisation/project selection, search over loaded issues, status filters, refresh and pagination.
- Issue creation, title/description editing, explicit status changes and human-attributed progress comments.
- Keyboard commands, modal focus handling, in-memory context-isolated drafts and draft-safe Quit confirmation.
- Light/dark appearance and narrow-window layout.
- Signed-manifest automatic updates, manual update checks, an automatic-download toggle, and installation on quit or restart. These are implemented features, not proof of notarized distribution or complete packaged-update acceptance.
- Native read-only pages (added October 28, 0.3.0): dashboard, projects, reports, team feed, mentions, unlinked PRs and my work log replace the old browser hand-offs. Issue rows open the native issue view, and GitHub PR rows open GitHub. Verified by page unit tests, a sidebar navigation UI test, and the connected test reading every page's live endpoints on the disposable stack. Project, sprint and milestone editing, reports filters and admin settings still open the web app.
- Read-only native sprints view (added October 27): sprints follow the project filter and open the active one, milestones show status, target date and done-of-total progress, and an expanded milestone lists its issues, which open in the native issue detail. Sprint transitions, milestone edits and milestone comments stay in the web app. Verified by unit, contract and native UI tests and by sample-data screenshots in both schemes. Not yet run against the live stack.
- Locked dependencies, local ad-hoc app packaging and a separate read-only macOS check workflow.

## October 31, 2026 hardening checks

- Updater parsing rejects malformed Unicode and non-hex signatures without panicking.
- Isolated updater tests cover private staging/probe collisions, unwritable destinations, missing candidates, helper startup and readiness failures, waiting for the parent to exit, successful swaps, failed swaps, rollback failures, relaunch failures and cleanup failures. Real shell-helper tests use disposable directories and substitute failing process boundaries; they never replace an installed user app.
- A native UI regression verifies that update-start failure preserves unsent drafts and keeps Velvet open. The credential-free native suite passes; Keychain consent and the real release-key check remain opt-in.
- The native workflow now covers API changes and pushes to `main`, not only desktop pull requests. Its default tests still do not replace the separately gated connected-server check.
- A real signed upgrade, exhaustive power-loss recovery and full VoiceOver acceptance remain unverified. Do not infer those outcomes from unit tests or helper simulations.

## Historical verification: October 27, 2026

- Final formatting and locked all-target Cargo checking passed.
- Final serial suite with `--features ui-tests` passed on October 27: 28 binary tests, 12 client integration tests and 11 contract tests. Three opt-in tests are ignored in this default run; Keychain and connected workflow checks are recorded separately. Some contract tests repeat across targets, so these are not unique test counts.
- Native UI tests cover issue selection, filters, workspace-isolated drafts, modal forward/backward Tab focus, Escape, blocked background mutations, saving/Quit guards, textarea Tab traversal, dropdown keyboard activation and actual semantic roles/labels.
- A separate real macOS Keychain round trip passed using a disposable account and removed its credential afterward.
- Real browser consent and the Rust client passed against the disposable API stack: desktop token polling, identity, issue changes, human-attributed progress comments and revocation. Test fixtures were removed.
- Five actual Metal-rendered screenshots captured desktop light/dark, narrow layout, commands and Quit confirmation under ignored `desktop/target/screenshots/`. Reviewed layouts were readable and contained.
- Final release packaging, plist validation and strict ad-hoc signature verification passed. Existing package output is protected against overwrite.
- The final packaged Apple Silicon app launched. Native checks verified issue navigation, new-issue draft retention, Quit confirmation, cancellation preserving the exact draft and clean process exit after clearing the test draft.
- API and web regression suites, web build and lint passed during desktop-auth integration.

Packaged GUI-to-server acceptance was exercised on October 27 against the guarded disposable stack, not a production account:

| Requirement | Concrete observation |
| --- | --- |
| Browser login and Keychain storage | The packaged app created its own desktop device session, browser approval completed, and the app stored its credential in the previously empty localhost Keychain slot. |
| Saved credential restore | Quitting and relaunching restored the same user's viewer workspace without another approval or token issuance. |
| Native create and edit | GUI actions created NAT-1, then changed its title and description. Disposable Postgres queries confirmed both writes. |
| Explicit status and human attribution | The native status menu changed NAT-1 to `in_progress`; a posted progress comment persisted with `source=human`. |
| Viewer boundary | Activating New in the restored viewer workspace did not open an editor or create another issue. |
| Revoked credential | After revoking only the fixture user's token, Refresh displayed the sanitized HTTP 401 error. |
| Keyboard access | Regression tests exercise Tab/Shift-Tab leaving textareas without changing drafts, Enter/Space activation, selected-row labels and menu dismissal. |
| Content semantics | Tests inspect actual native roles and labels for workspace, comment author/body, deleted-comment redaction and editor heading. |

The final c39a3c3 package was also launched against the same real server after the accessibility changes. Its native accessibility tree populated without resizing; refusing login saved no token or Keychain entry, retry approval succeeded, organisation selection opened with accessibility Press, and selected-row/comment author/body labels were visible from live data. These observations establish improvement over the previous package, not full VoiceOver or web-feature parity.

## Release evidence and remaining boundaries

- Exhaustive packaged GUI failure-state coverage remains incomplete. Core live create/edit/comment/status and credential restore have now passed.
- Full VoiceOver acceptance remains unverified. The previous package reproducibly exposed an empty accessibility tree until resize. The final package populated immediately and updated after login and issue selection, but that single successful launch does not prove the intermittent upstream activation behavior is eliminated. No continuous redraw workaround was added.
- Final October 27 DMG creation, read-only mounting, copying into an isolated fresh-install directory, plist validation, executable hash matching, strict ad-hoc signature verification and clean detach all passed. No user application was replaced.
- DMG: `desktop/dist/Velvet-0.1.0-preview-arm64-NOT-NOTARIZED.dmg`, SHA-256 `3c6bb06c721c1c919aafd9f5f6191a990c993111826fc86f0caafa74f6e10456`.
- Production sign-in requires a server with the dedicated desktop-auth migration and handlers. Package verification does not establish deployment success; rollout and native remote-check results must be checked independently.
- `security find-identity -v -p codesigning` reported zero valid identities on October 31, 2026. Developer ID signing, notarization and trusted clean-machine distribution remain blocked, not completed. Credentials and explicit release approval must be supplied separately.
- An upstream `block` future-compatibility warning from GPUI's dependencies remains. Local unused-field warnings were removed on October 27.
- New issues created under a project filter now send the project key the API expects, not the project id. This was fixed on October 27 and covered by a unit test, but not yet re-run against the live stack.
- Work-log recording was blocked: `velvet whoami` exited 3 because the CLI was not signed in. No successful log is claimed.

## Build environment

Verified on macOS 26.4.1 arm64 with Rust/Cargo 1.97.1 in `~/.cargo/bin` and Apple Command Line Tools. GPUI kit is pinned to 0.7.0 with runtime shaders, so this configuration does not require full Xcode or the offline Metal compiler. The generated `desktop/dist/Velvet Preview.app` is a local ad-hoc-signed preview, not a notarized distribution.

## Remaining feature and distribution boundaries

- Offline database, offline writes, durable queues and conflict resolution.
- Intel/universal packages and other operating systems.
- Developer ID signing, notarization, stapling and trusted clean-machine distribution.
- Native sprint planning and transitions, project and milestone editing, milestone comments, image attachments, report filters, profile and administration. Native read-only dashboard, feed, mentions, reports, work log and unlinked PR pages are already implemented as described above. Issue and comment writes are native, while other write workflows still use the web app.
- Release approval. Builds, commits and local verification do not authorize a public release, notarization submission or server deployment.

Issue statuses never change automatically because a branch, commit, PR, package or deployment exists. The web application remains the reference for workflows not yet implemented natively.
