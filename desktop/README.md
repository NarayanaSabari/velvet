# Velvet desktop preview

Native Rust/GPUI application, not a webview wrapper. This is an online-first Apple Silicon preview, not a production release. See [parity.md](parity.md) for the evidence boundary and remaining work.

## Toolchain and build requirements

`Cargo.toml` is the source of truth for the `velvet-desktop` version. It uses Rust edition 2024, with `gpui-kit` pinned to `=0.7.0`. Commit and use `Cargo.lock`; build commands below use `--locked`.

Local inspection on October 26, 2026 found:

- Apple Silicon (`arm64`), macOS 26.4.1.
- Rust and Cargo 1.97.1 in `~/.cargo/bin`, outside the shell's initial `PATH`.
- Active developer directory `/Library/Developer/CommandLineTools`, with Apple clang and the macOS SDK available through `xcrun`.

GPUI kit 0.7.0 enables `gpui_platform`'s `runtime_shaders` feature, so the OS compiles shaders at runtime. Building requires Apple clang and the macOS SDK, not the offline `metal` compiler or full Xcode. Command Line Tools satisfy those checked prerequisites on this machine. These observations do not establish a supported minimum macOS version or prove a packaged app launches.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd desktop
rustc --version
xcrun --find clang
xcrun --show-sdk-path
cargo fmt --all -- --check
cargo check --locked --all-targets --features ui-tests
cargo test --locked --features ui-tests -- --test-threads=1
cargo run --locked -- --server https://velvet.example.com
# Read-only sample data, without network or Keychain access:
cargo run --locked -- --demo
```

The native binary accepts `--server URL`, `--demo`, and `--help`. Server URLs require HTTPS except for HTTP loopback during local development. `--demo` is read-only sample data, not proof of live server behavior. To pass arguments to a packaged preview:

```bash
open desktop/dist/Velvet.app --args --server https://velvet.example.com
open desktop/dist/Velvet.app --args --demo
```

Quit any running preview before launching it with different arguments.

The application talks to an existing Velvet server. Server deployment, database migrations and production credentials are outside this package's responsibilities. Do not put tokens or `.env` files inside the app bundle or distribution directory. Credential storage must use macOS Keychain, not a bundled config file.

## Local packaging

From the repository root:

```bash
./desktop/package.sh
# Only when a disk image is wanted:
./desktop/package.sh --dmg
```

The script requires native Apple Silicon macOS and a native Rust toolchain. It builds release mode with `--locked`, an explicit `aarch64-apple-darwin` target, and a fixed `desktop/target` output directory. It validates `Info.plist`, assembles `desktop/dist/Velvet.app`, stamps the `Cargo.toml` version into `Info.plist`, applies and verifies an ad-hoc signature, and writes the update zip. `desktop/dist` must remain ignored by Git. Existing destination apps or requested DMGs cause an error instead of being overwritten. Move prior output aside before another package run.

`--dmg` additionally uses `hdiutil` to create `Velvet-<version>-arm64.dmg`, containing the app and an Applications shortcut. Without that flag no disk image is created. Scratch staging directories are removed when the script exits. Failed disk-image creation can leave a partial output file, which must be inspected and moved aside before retrying.

**Velvet is ad-hoc signed, not notarized.** An ad-hoc signature is not an Apple Developer ID signature. On first install, macOS blocks the app once. Right-click Velvet in Applications, choose Open, then confirm, or allow it under System Settings > Privacy & Security. Do not disable Gatekeeper globally.

Install from the release DMG: drag Velvet to Applications. There is no offline database, offline write queue, migration engine or conflict resolution. No offline durability or successful background sync is promised.

## Versioned releases and self-update

Each desktop release is a GitHub Release tagged `desktop-vX.Y.Z` on `NarayanaSabari/velvet`, separate from the CLI's `vX.Y.Z` tags. It carries `Velvet-X.Y.Z-arm64.zip` and a `latest.json` manifest holding the version, archive URL, SHA-256 and an ed25519 signature over `velvet-desktop:<version>:<sha256>`.

A packaged app checks for updates at launch, every 6 hours while open, and from **Velvet > Check for Updates…** or the account menu at the bottom of the sidebar. It ignores drafts, prereleases and versions not newer than its own, and trusts a manifest only when its signature matches the public key compiled from `update-public-key.hex`.

**Automatic updates** (default on, toggled in the sidebar account menu or the Velvet menu, stored in `~/Library/Application Support/Velvet/auto-update`) download and verify a new release in the background. It installs the next time Velvet quits, or immediately with **Restart now**. With automatic updates off, the banner offers **Update** to download first. Verification covers SHA-256, bundle identifier, version and code signature. Every quit path, including the draft-safe Quit prompt, hands the staged bundle to a detached helper that waits for exit, swaps the bundle, and attempts to restore the old one if the swap fails. Background checks fail silently offline. Unbundled `cargo run` builds skip automatic startup and periodic checks, but the manual menu action still calls GitHub through `check_for_updates`. Download/install preparation separately requires an app bundle and reports an error when none exists.

Update preparation now reserves private, unique staging and probe directories instead of overwriting fixed paths. Before quitting, Velvet copies the candidate beside the installed app and waits for the helper to acknowledge readiness. A preparation or helper-start failure leaves the app and its drafts open, shows the error, and allows another download or a normal quit. The helper retains a failure journal and any recovery bundle under `.velvet-update-*` beside the app. The next manual launch reports that failure and its recovery path. If automatic rollback itself fails, restore the retained `previous.app` manually rather than deleting the recovery directory. A successful update removes its transaction directory. These safeguards do not establish power-loss atomicity or notarization.

The app must sit in a folder the user can write to. `/Applications` works for admin users. Because the app is not notarized, the first install still needs the manual Gatekeeper approval. Updates downloaded by the app itself carry no quarantine flag.

To release:

```bash
# 1. Bump version in desktop/Cargo.toml, run cargo check to refresh Cargo.lock, commit and push.
# 2. Publish (builds, signs, tags, uploads):
./desktop/release.sh 0.2.0 --notes "Sprints view and self-update"
```

The signing key defaults to `~/.config/velvet/desktop-update-key.hex` (override with `VELVET_UPDATE_KEY`). Never commit it. Back it up somewhere safe, because losing it means installed apps can no longer accept updates and need one manual reinstall with a new public key. Generate a replacement with `cargo run --example update_key -- generate <new-file>` and write its printed public key to `update-public-key.hex`.

Developer ID signing, hardened-runtime and entitlement review, notarization, stapling, clean-machine launch verification and public distribution remain gated on separately supplied Apple credentials and explicit release approval. This script neither requests nor reads those credentials and never deploys anything.

## Checks and CI

```bash
bash -n desktop/package.sh
plutil -lint desktop/Info.plist
./desktop/package.sh --help
```

`.github/workflows/desktop.yml` runs on manual dispatch, pull requests and pushes to `main` touching `desktop/**`, `api/**` or that workflow. API changes therefore run native client checks too. It uses read-only repository permissions, Rust 1.97.1, and native macOS formatting, locked all-target checking with `ui-tests`, and serial native UI and client tests. It checks packaging syntax and metadata but intentionally avoids another release build or a DMG. The opt-in connected test still requires a separately running disposable stack and is not part of this macOS job. It uploads no release artifact, uses no Apple credentials and has no production deployment step. Existing repository-wide workflows remain independent.

A syntax check or plist validation is not evidence that the app, Keychain behavior, authentication, DMG, signature trust or native UI works. Record actual build, test and launch results in [parity.md](parity.md) as they become available.

## Subdirectories & System Boundaries

- `src`: [./src/README.md](./src/README.md) - `velvet-desktop` binary: GPUI `Velvet` view, blocking `ApiClient`, Keychain `credentials`, page builders, state helpers, theme, and the signed self-updater with its `update_swap.sh` helper.
- `examples`: [./examples/README.md](./examples/README.md) - Developer tools: demo-only `screenshots` (feature `ui-tests`) and the `update_key` ed25519 key generator and signer.
- `tests`: integration tests (`native_api.rs`, `native_updater.rs`, `real_server.rs`). `real_server` is `#[ignore]` and needs the disposable e2e stack from [e2e/README.md](../e2e/README.md).

## Global Invariants

- Server URLs pass `api::normalize_server`: HTTPS only, except HTTP on loopback, with no credentials, query, or fragment.
- Tokens live only in macOS Keychain under service `app.velvet.desktop`, never in the bundle, `dist`, or config files.
- `--demo` seeds sample data (`app.rs:seed_demo`) instead of `restore`, so it skips Velvet server and Keychain access. A packaged app still runs the GitHub update check (`update::running_bundle`).
- Updates are trusted only with a valid ed25519 signature from the key in `update-public-key.hex`. The private key is never committed.
- No offline queue or local database exists. All data comes from the live server.

## Global Side Effects

- HTTPS calls to the configured Velvet server and to the GitHub Releases API for `NarayanaSabari/velvet`.
- macOS Keychain reads and writes.
- `~/Library/Application Support/Velvet/auto-update` preference file.
- `.velvet-update-*` transaction directories and a detached swap helper beside the installed app.
- `package.sh [--dmg]` builds `--locked` for `aarch64-apple-darwin` into `desktop/target`, ad-hoc signs, and writes `dist/Velvet.app`, `dist/Velvet-<version>-arm64.zip`, and optionally the `.dmg`. It refuses existing outputs and requires `dist` to be git-ignored.
- `release.sh <X.Y.Z> [--notes text]` requires a clean desktop subtree excluding `dist` and `target`, not a clean whole repository, plus a matching `Cargo.toml` version and a readable `VELVET_UPDATE_KEY`. Before packaging, it moves an existing `dist/Velvet.app` into a fresh `dist/.previous.*` directory. The script does not clean up that retained directory, including after a later failure. It runs `package.sh --dmg`, signs via `update_key sign`, writes `dist/latest.json`, pushes tag `desktop-v<version>`, and creates the GitHub Release on `NarayanaSabari/velvet` with `gh`.

## System Verification

- Run: `cd desktop && cargo test --locked --features ui-tests -- --test-threads=1`
