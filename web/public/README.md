# public

## Overview
Static files Vite copies as-is into the build output. Holds the favicon, the icon sprite, and the CLI installer.

## Interface
- `favicon.svg`, `icons.svg`: static assets.
- `install.sh`: POSIX `sh` installer for the `velvet` CLI, meant for `curl -fsSL <server>/install.sh | sh`.
  - `VELVET_SERVER`: server to download from. Defaults to `https://velvet.sabarinarayana.com`. A trailing `/` is stripped.
  - `VELVET_INSTALL_DIR`: install directory. Defaults to `$HOME/.local/bin`.

## Invariants
- Supports `Darwin`/`Linux` and `arm64|aarch64`/`x86_64|amd64` only. Other platforms exit 1.
- Binary name is `velvet-$os-$arch`.
- Installs only when the SHA-256 matches the `SHA256SUMS` entry. A missing entry or mismatch exits 1 without installing.
- Uses `sha256sum`, falling back to `shasum -a 256`.

## Side Effects
- Downloads `$server/download/$name` and `$server/download/SHA256SUMS` into a `mktemp -d` dir, removed on exit by `trap`.
- Creates `$dir` and installs `$dir/velvet` with mode `0755`, then runs `velvet --version`.
- Prints a PATH hint if `$dir` is not on `PATH`.

## Verification
- Run: `sh -n web/public/install.sh` (syntax check). There are no automated tests for this script.
