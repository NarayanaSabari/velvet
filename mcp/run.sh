#!/usr/bin/env bash
# Launches the Velvet MCP server for this repository's workspace.
# Token and URL come from envkit's project env; workspace can be overridden
# by setting VELVET_WORKSPACE before calling.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export VELVET_WORKSPACE="${VELVET_WORKSPACE:-personal}"
exec /Users/sabari/.local/bin/envkit run -- node mcp/dist/index.js
