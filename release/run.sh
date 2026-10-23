#!/usr/bin/env bash
# Release root launcher: keep this file next to the Stronghold-Protocol-Vanilla-20p folder.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/Stronghold-Protocol-Vanilla-20p/scripts/start.sh" "$@"