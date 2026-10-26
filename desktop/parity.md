# Desktop parity and verification

Snapshot: October 26, 2026. This is a first native preview slice, not web-feature parity. A checked source item means code exists, not that a person has completed the workflow in a packaged application. Keep source implementation and runtime evidence separate.

## Source baseline

- [x] Rust package `velvet-desktop` version `0.1.0`, edition 2024, GPUI kit pinned to `0.8.1`.
- [x] Native GPUI application entry point and window scaffold.
- [x] Explicit local-preview app metadata and Apple Silicon packaging script, optional DMG flag, ad-hoc signing only.
- [x] Separate read-only manual/PR macOS workflow for formatting, locked checking and tests, with no deployment.
- [ ] Confirm browser-approved desktop authentication and macOS Keychain credential lifecycle in the integrated native app.
- [ ] Confirm authenticated organisation/project selection and server data loading in the integrated native app.
- [ ] Confirm issue list, issue detail, explicit issue status edits and work-log creation in the integrated native app.

The authentication, API client and richer GPUI surfaces are being built alongside this packaging work. Update this list only from the integrated source and actual verification results, not the design mockup or planned scope.

## Preview acceptance evidence

- [x] `bash -n desktop/package.sh` passed.
- [x] `plutil -lint desktop/Info.plist` passed.
- [x] `--help` returned success. Unknown options and extra arguments returned exit code 2.
- [x] A real packaging attempt stopped before compilation when the Metal compiler was unavailable.
- [ ] Native `cargo fmt --all -- --check`, `cargo check --locked --all-targets` and `cargo test --locked` results from the completed source.
- [ ] Release binary built and launched on Apple Silicon.
- [ ] Packaged `.app` launch, bundle resources and signature verification.
- [ ] Optional DMG creation, mount and manual install.
- [ ] Browser consent, token expiry, cancellation, logout, server switching and Keychain failures.
- [ ] Real-server issue read/write and work-log workflows, including membership and permission failures.
- [ ] Keyboard-only use, visible focus, VoiceOver, long content, loading, empty, error and saving states.
- [ ] Light/dark schemes and native window resizing, including narrow layout and no horizontal overflow.

Local blocker: macOS 26.4.1 on arm64 has Rust/Cargo 1.97.1 in `~/.cargo/bin`, but the active Command Line Tools installation has no Metal compiler and full Xcode was not present at `/Applications/Xcode.app`. Packaging preflight fails safely. No `.app` or DMG build, native launch or distribution verification is claimed by this document.

## Deliberately outside the first slice

- [ ] Offline database, offline writes, durable queue and conflict resolution.
- [ ] Automatic updater or update feed. Preview updates are manual replacements.
- [ ] Intel, universal, Windows, Linux or mobile packages.
- [ ] Developer ID signing, notarization, stapling and trusted clean-machine installation. These require Apple credentials and separate release approval.
- [ ] Full web navigation and feature parity: dashboard/feed, sprint planning and boards, milestones, comments and mentions, image attachments, GitHub evidence and suggestions, reports/recaps, command palette, profile and administration.
- [ ] Production deployment or public release. Packaging and CI do not authorize either.

No issue status changes automatically because a branch, commit, PR, package or deployment exists. The existing web application remains the reference for workflows not yet implemented natively. No completion date or parity schedule is implied.
