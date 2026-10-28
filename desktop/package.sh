#!/bin/bash
set -euo pipefail

usage() {
    printf '%s\n' 'Usage: desktop/package.sh [--dmg]' \
        'Build the Apple Silicon Velvet app. Ad-hoc signed, not notarized.' \
        'Creates desktop/dist/Velvet.app and an update zip; --dmg also creates a disk image.' \
        'The version comes from Cargo.toml.'
}

dmg=false
case "${1:-}" in
    '') ;;
    --dmg) dmg=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then usage >&2; exit 2; fi

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || \
    fail 'Velvet packages only native Apple Silicon macOS builds.'
root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"
for tool in cargo rustc xcrun plutil codesign ditto git; do
    command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
[[ "$(rustc -vV)" == *'host: aarch64-apple-darwin'* ]] || \
    fail 'Use a native aarch64-apple-darwin Rust toolchain.'
xcrun --find clang >/dev/null 2>&1 || fail 'Apple clang unavailable. Install or select Command Line Tools.'
xcrun --show-sdk-path >/dev/null 2>&1 || fail 'macOS SDK unavailable. Install or select Command Line Tools.'
if "$dmg"; then command -v hdiutil >/dev/null || fail 'Missing tool: hdiutil'; fi

dist="$root/dist"
app="$dist/Velvet.app"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -1)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unreadable Cargo.toml version: $version"
image="$dist/Velvet-$version-arm64.dmg"
archive="$dist/Velvet-$version-arm64.zip"
git check-ignore -q dist/Velvet.app || fail 'desktop/dist must be git-ignored.'
[[ ! -e "$app" && ! -L "$app" ]] || fail "Output exists: $app. Move it aside before rebuilding."
[[ ! -e "$archive" ]] || fail "Output exists: $archive. Move it aside before rebuilding."
if "$dmg"; then
    [[ ! -e "$image" && ! -L "$image" ]] || fail "Output exists: $image. Move it aside before rebuilding."
fi
plutil -lint Info.plist
# An explicit native target avoids an inherited Cargo cross-compilation default.
cargo build --release --locked --target aarch64-apple-darwin --target-dir "$root/target"
mkdir -p "$dist"
stage="$(mktemp -d "$dist/.package.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Velvet.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
ditto Info.plist "$bundle/Contents/Info.plist"
# The updater compares these against the signed manifest.
plutil -replace CFBundleShortVersionString -string "$version" "$bundle/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$bundle/Contents/Info.plist"
ditto target/aarch64-apple-darwin/release/velvet-desktop "$bundle/Contents/MacOS/velvet-desktop"
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$bundle"
codesign --verify --strict --verbose=2 "$bundle"
# Update archive: a zip with the app at its root, read by desktop/src/update.rs.
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
if "$dmg"; then
    ln -s /Applications "$stage/Applications"
    hdiutil create -volname "Velvet $version" -srcfolder "$stage" \
        -format UDZO "$image"
fi
mv "$bundle" "$app"
printf 'Update archive: %s\n' "$archive"
printf 'App: %s\nAd-hoc signed, not notarized.\n' "$app"
if "$dmg"; then printf 'Disk image: %s\n' "$image"; fi
