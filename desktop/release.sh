#!/bin/bash
# Publish a desktop release that installed apps pick up through self-update.
#
#   desktop/release.sh <version> [--notes "text"]
#
# Requires a clean tree with Cargo.toml already at <version>, the signing key at
# $VELVET_UPDATE_KEY (default ~/.config/velvet/desktop-update-key.hex) and gh.
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Usage: desktop/release.sh <X.Y.Z> [--notes text]'
notes="Velvet desktop $version"
if [[ "${2:-}" == --notes ]]; then notes="${3:?--notes needs text}"; fi

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
key="${VELVET_UPDATE_KEY:-$HOME/.config/velvet/desktop-update-key.hex}"
[[ -r "$key" ]] || fail "Signing key not readable: $key"
repo="NarayanaSabari/velvet"
tag="desktop-v$version"
grep -q "^version = \"$version\"$" Cargo.toml || fail "Cargo.toml is not at $version. Bump it and commit first."
[[ -z "$(git status --porcelain -- . ':!dist' ':!target')" ]] || fail 'Commit desktop changes before releasing.'
gh release view "$tag" -R "$repo" >/dev/null 2>&1 && fail "Release $tag already exists."

# Never publish a build whose tests fail or that does not pass clippy.
echo "Running tests…"
cargo test --locked --features ui-tests >/dev/null 2>&1 || fail 'Tests fail. Fix them before releasing.'
cargo clippy --locked --features ui-tests >/dev/null 2>&1 || fail 'Clippy fails. Fix it before releasing.'

archive="dist/Velvet-$version-arm64.zip"
[[ -e "$archive" || -e "dist/Velvet-$version-arm64.dmg" ]] && fail "Output for $version exists in dist/. Move it aside before releasing."
rm -rf dist/Velvet.app
./package.sh --dmg
dmg="dist/Velvet-$version-arm64.dmg"
# Only the zip and dmg are kept; a loose .app here would show up in Spotlight
# as a second install next to /Applications/Velvet.app.
mv dist/Velvet.app "dist/.Velvet-$version.app"

sha="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
signature="$(cargo run -q --locked --example update_key -- sign "$key" "$version" "$sha")"
url="https://github.com/$repo/releases/download/$tag/$(basename "$archive")"
manifest="dist/latest.json"
NOTES="$notes" VERSION="$version" URL="$url" SHA="$sha" SIG="$signature" \
    /usr/bin/python3 -c 'import json,os; print(json.dumps({"version":os.environ["VERSION"],"url":os.environ["URL"],"sha256":os.environ["SHA"],"notes":os.environ["NOTES"],"signature":os.environ["SIG"]}, indent=2))' > "$manifest"

git tag -a "$tag" -m "Velvet desktop $version"
git push origin "$tag"
gh release create "$tag" -R "$repo" --title "Velvet desktop $version" --notes "$notes" \
    "$archive" "$dmg" "$manifest"
printf 'Published %s. Installed apps offer it on next launch.\n' "$tag"
