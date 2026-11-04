# desktop/examples

## Overview

Developer tools built as Cargo examples. They share the app modules but are not part of the shipped binary.

## Interface

- `screenshots.rs`: `main`. Requires feature `ui-tests` (`Cargo.toml` `[[example]] required-features`). Includes `../src/*.rs` via `#[path]` and renders `app::Velvet` in demo mode at the viewports `desktop-light`, `desktop-dark`, `narrow-light`, `commands-light`, `quit-light`, `sprints-light`, `sprints-dark`. Run: `cargo run --features ui-tests --example screenshots`.
- `update_key.rs`: `main`, `hex`. `cargo run --example update_key -- generate <new-file>` writes a PKCS#8 hex ed25519 private key (mode 600, refuses to overwrite) and prints the public key hex. `sign <file> <version> <sha256>` prints a signature hex over `velvet-desktop:<version>:<sha256>`.

## Invariants

- `screenshots.rs` uses only read-only demo data (`Velvet::new(DEFAULT_SERVER, true, ..)`) and must run on the process main thread.
- Signing keys created by `update_key.rs` must never be committed. Only the public key belongs in `update-public-key.hex`.

## Side Effects

- `screenshots.rs` writes PNGs under ignored `target/screenshots`.
- `update_key.rs` writes a private key file at the given path and never overwrites an existing one.

## Verification

- Run: `cd desktop && cargo check --locked --all-targets --features ui-tests`
