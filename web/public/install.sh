#!/bin/sh
# Installs the velvet CLI from this Velvet server.
#
#   curl -fsSL https://velvet.example.com/install.sh | sh
#
# VELVET_SERVER picks the server to download from (default: the hosted
# Velvet; set it for a self-hosted one). VELVET_INSTALL_DIR picks the
# directory (default: ~/.local/bin). The binary is checked against the
# server's SHA256SUMS before it is installed.
set -eu

server="${VELVET_SERVER:-https://velvet.sabarinarayana.com}"
server="${server%/}"
dir="${VELVET_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "velvet: unsupported system $(uname -s); build from source in cli/" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) echo "velvet: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

name="velvet-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$server/download/$name" -o "$tmp/$name"
curl -fsSL "$server/download/SHA256SUMS" -o "$tmp/SHA256SUMS"

want="$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$name" | awk '{ print $1 }')"
else
  got="$(shasum -a 256 "$tmp/$name" | awk '{ print $1 }')"
fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "velvet: checksum mismatch for $name; not installing" >&2
  exit 1
fi

mkdir -p "$dir"
install -m 0755 "$tmp/$name" "$dir/velvet"
echo "Installed $("$dir/velvet" --version) to $dir/velvet"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Next, in your repository: velvet init"
