#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

# NODE_NO_WARNINGS suppresses the experimental-ESM-in-require warning tsx
# triggers on Node 23+; keeps stdout clean for pipelines that redirect it.
export NODE_NO_WARNINGS=1
exec npx --no-install tsx "$ROOT/scripts/release-gate.ts" "$@"
