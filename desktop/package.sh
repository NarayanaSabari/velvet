#!/bin/bash
set -euo pipefail

usage() {
    printf '%s\n' 'Usage: desktop/package.sh [--dmg]' \
        'Build an Apple Silicon local preview. Ad-hoc signed, NOT notarized.' \
        'Creates desktop/dist/Velvet Preview.app; --dmg also creates a disk image.'
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
    fail 'This preview packages only native Apple Silicon macOS builds.'
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
app="$dist/Velvet Preview.app"
image="$dist/Velvet-0.1.0-preview-arm64-NOT-NOTARIZED.dmg"
git check-ignore -q dist/Velvet\ Preview.app || fail 'desktop/dist must be git-ignored.'
[[ ! -e "$app" && ! -L "$app" ]] || fail "Output exists: $app. Move it aside before rebuilding."
if "$dmg"; then
    [[ ! -e "$image" && ! -L "$image" ]] || fail "Output exists: $image. Move it aside before rebuilding."
fi
plutil -lint Info.plist
# An explicit native target avoids an inherited Cargo cross-compilation default.
cargo build --release --locked --target aarch64-apple-darwin --target-dir "$root/target"
mkdir -p "$dist"
stage="$(mktemp -d "$dist/.package.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Velvet Preview.app"
mkdir -p "$bundle/Contents/MacOS"
ditto Info.plist "$bundle/Contents/Info.plist"
ditto target/aarch64-apple-darwin/release/velvet-desktop "$bundle/Contents/MacOS/velvet-desktop"
printf '%s\n' 'LOCAL PREVIEW: ad-hoc signed only. NOT notarized. Manual updates only.' > "$bundle/Contents/PREVIEW.txt"
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$bundle"
codesign --verify --strict --verbose=2 "$bundle"
if "$dmg"; then
    ln -s /Applications "$stage/Applications"
    hdiutil create -volname 'Velvet Preview NOT Notarized' -srcfolder "$stage" \
        -format UDZO "$image"
fi
mv "$bundle" "$app"
printf 'Local preview: %s\nAd-hoc signed only. NOT notarized.\n' "$app"
if "$dmg"; then printf 'Manual-install disk image: %s\n' "$image"; fi
