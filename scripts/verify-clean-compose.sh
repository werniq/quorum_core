#!/usr/bin/env bash
# Thin wrapper for Linux CI — delegates to the Node.js implementation.
set -euo pipefail
exec node "$(dirname "$0")/verify-clean-compose.mjs" "$@"
