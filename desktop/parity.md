# Desktop parity and verification

Snapshot: October 26, 2026. This is a first native preview slice, not web-feature parity. A checked source item means code exists, not that a person has completed the workflow in a packaged application. Keep source implementation and runtime evidence separate.

## Source baseline

- [x] Rust package `velvet-desktop` version `0.1.0`, edition 2024, GPUI kit pinned to `0.7.0`.
- [x] Native GPUI workspace shell, issue list/detail and read-only `--demo` data. `--server URL` selects an HTTPS server, with HTTP allowed only for loopback.
- [x] Source implementation of browser-approved desktop authentication, token restoration/revocation and macOS Keychain storage.
- [x] Source implementation of workspace/project selection, issue search/status filtering, refresh and pagination.
- [x] Source implementation of issue creation/editing, explicit status changes and issue timeline comments. Live-server acceptance remains unchecked below.
- [x] Explicit local-preview app metadata and Apple Silicon packaging script, optional DMG flag, ad-hoc signing only.
- [x] Separate read-only manual/PR macOS workflow for formatting, locked checking and tests, with no deployment.
- [ ] Confirm browser-approved desktop authentication and macOS Keychain credential lifecycle in the integrated native app.
- [ ] Confirm authenticated organisation/project selection and server data loading in the integrated native app.
- [ ] Confirm issue list, issue detail, explicit issue status edits and work-log creation in the integrated native app.

The source checklist records the integrated code paths, not proof of successful consent, credentials or live writes. Update runtime evidence only from actual verification results, not the design mockup or sample data.

## Preview acceptance evidence

- [x] `bash -n desktop/package.sh` passed.
- [x] `plutil -lint desktop/Info.plist` passed.
- [x] `--help` returned success. Unknown options and extra arguments returned exit code 2.
- [x] Apple clang and macOS SDK preflight passed with Command Line Tools. An isolated Cargo shim confirmed packaging reaches the explicit locked native release build command without requiring the offline Metal compiler.
- [ ] Native `cargo fmt --all -- --check`, `cargo check --locked --all-targets` and `cargo test --locked` results from the completed source.
- [x] The coordinator reported a successful native release build before the bundle-resource correction.
- [x] The coordinator reported native unit suites with 15 and 12 passing tests, with two interactive Keychain tests ignored. These do not prove live Keychain round trips or real-server writes.
- [ ] Release binary launched on Apple Silicon.
- [x] Actual native release packaging succeeded after placing `PREVIEW.txt` in `Contents/Resources`; bundle plist validation and `codesign --verify --strict` passed. The packaged binary's `--help` worked, and another packaging attempt refused to overwrite the existing app. No DMG was requested or created.
- [ ] Packaged `.app` GUI launch and final UI acceptance. The successful packaging artifact predates final UI acceptance and must be rebuilt after the coordinator's signal.
- [ ] Optional DMG creation, mount and manual install.
- [ ] Browser consent, token expiry, cancellation, logout, server switching and Keychain failures.
- [ ] Real-server issue read/write and work-log workflows, including membership and permission failures.
- [ ] Keyboard-only use, visible focus, VoiceOver, long content, loading, empty, error and saving states.
- [ ] Light/dark schemes and native window resizing, including narrow layout and no horizontal overflow.

Local toolchain: macOS 26.4.1 on arm64 has Rust/Cargo 1.97.1 in `~/.cargo/bin`, and the active Command Line Tools installation provides Apple clang and the macOS SDK. GPUI kit 0.7.0 enables `gpui_platform/runtime_shaders`, so missing full Xcode or the offline Metal compiler is not a build blocker for this configuration. The coordinator reported a successful `cargo check` and native release build with the settled kit pin. Final formatting, check and test evidence still belongs to the completed integrated source. Native app launch, optional DMG installation and trusted distribution remain separate acceptance checks.

Work-log write was not completed: the coordinator reported CLI exit code 3. No successful Velvet log is claimed here. The coordinator owns repository-binding/authentication follow-up and the consolidated entry.

## Deliberately outside the first slice

- [ ] Offline database, offline writes, durable queue and conflict resolution.
- [ ] Automatic updater or update feed. Preview updates are manual replacements.
- [ ] Intel, universal, Windows, Linux or mobile packages.
- [ ] Developer ID signing, notarization, stapling and trusted clean-machine installation. These require Apple credentials and separate release approval.
- [ ] Full web navigation and feature parity: dashboard/feed, sprint planning and boards, milestones, comments and mentions, image attachments, GitHub evidence and suggestions, reports/recaps, command palette, profile and administration.
- [ ] Production deployment or public release. Packaging and CI do not authorize either.

No issue status changes automatically because a branch, commit, PR, package or deployment exists. The existing web application remains the reference for workflows not yet implemented natively. No completion date or parity schedule is implied.
