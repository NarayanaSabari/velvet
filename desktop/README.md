# Velvet desktop preview

Native Rust/GPUI application, not a webview wrapper. This is an online-first Apple Silicon preview, not a production release. See [parity.md](parity.md) for the evidence boundary and remaining work.

## Toolchain and build requirements

`Cargo.toml` names `velvet-desktop` version `0.1.0`, Rust edition 2024, with `gpui-kit` pinned to `=0.8.1`. Commit and use `Cargo.lock`; build commands below use `--locked`.

Local inspection on October 26, 2026 found:

- Apple Silicon (`arm64`), macOS 26.4.1.
- Rust and Cargo 1.97.1 in `~/.cargo/bin`, outside the shell's initial `PATH`.
- Active developer directory `/Library/Developer/CommandLineTools`, no `/Applications/Xcode.app`, and no Metal compiler from `xcrun --find metal`.

Full Xcode with the Metal compiler available through the selected developer directory is a packaging prerequisite. Command Line Tools alone did not meet it on this machine. Installing Xcode or changing the selected developer directory is a separate, deliberate local setup action. These observations do not establish a supported minimum macOS version or prove the app builds and launches.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd desktop
rustc --version
xcrun --find metal
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo test --locked
cargo run --locked
```

The application talks to an existing Velvet server. Server deployment, database migrations and production credentials are outside this package's responsibilities. Do not put tokens or `.env` files inside the app bundle or distribution directory. Credential storage must use macOS Keychain, not a bundled config file.

## Local packaging

From the repository root:

```bash
./desktop/package.sh
# Only when a disk image is wanted:
./desktop/package.sh --dmg
```

The script requires native Apple Silicon macOS and a native Rust toolchain. It builds release mode with `--locked`, an explicit `aarch64-apple-darwin` target, and a fixed `desktop/target` output directory. It validates `Info.plist`, assembles `desktop/dist/Velvet Preview.app`, and applies and verifies an ad-hoc signature. `desktop/dist` must remain ignored by Git. Existing destination apps or requested DMGs cause an error instead of being overwritten. Move prior output aside before another package run.

`--dmg` additionally uses `hdiutil` to create `Velvet-0.1.0-preview-arm64-NOT-NOTARIZED.dmg`, containing the app and an Applications shortcut. Without that flag no disk image is created. Scratch staging directories are removed when the script exits. Failed disk-image creation can leave a partial output file, which must be inspected and moved aside before retrying.

**This is ad-hoc signed only, NOT notarized.** The bundle's display name and included `PREVIEW.txt` say so. An ad-hoc signature is not an Apple Developer ID signature and does not establish a trusted publisher. Gatekeeper may block a downloaded preview. Do not disable Gatekeeper or remove quarantine globally to install it. Only run a local build whose source and origin you trust.

Distribution is a direct, manually installed preview app or optional DMG. Updates are manual: quit the app, obtain a trusted replacement, and replace the installed preview. There is no automatic updater, update feed, offline database, offline write queue, migration engine or conflict resolution in this slice. No offline durability or successful background sync is promised.

Developer ID signing, hardened-runtime and entitlement review, notarization, stapling, clean-machine launch verification and public distribution remain gated on separately supplied Apple credentials and explicit release approval. This script neither requests nor reads those credentials and never deploys anything.

## Checks and CI

```bash
bash -n desktop/package.sh
plutil -lint desktop/Info.plist
./desktop/package.sh --help
```

`.github/workflows/desktop.yml` runs only on manual dispatch and pull requests touching `desktop/**` or that workflow. It uses read-only repository permissions, Rust 1.97.1, and native macOS formatting, locked check and locked tests. It checks packaging syntax and metadata but intentionally avoids another release build or a DMG. It uploads no release artifact, uses no Apple credentials and has no production deployment step. Existing repository-wide workflows remain independent.

A syntax check or plist validation is not evidence that the app, Keychain behavior, authentication, DMG, signature trust or native UI works. Record actual build, test and launch results in [parity.md](parity.md) as they become available.
