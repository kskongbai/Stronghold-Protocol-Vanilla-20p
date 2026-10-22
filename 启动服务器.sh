#!/usr/bin/env bash
# 卫戍协议：盟约 · one-click launcher for macOS / Linux.
set -euo pipefail
cd "$(dirname "$0")"
exec bash scripts/start.sh "$@"
