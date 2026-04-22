#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

# NODE_NO_WARNINGS suppresses the experimental-ESM-in-require warning tsx /
# node emit on Node 23+; keeps stdout clean for pipelines that capture it
# (e.g. the runner's $(./scripts/context.sh render ...) call).
export NODE_NO_WARNINGS=1
exec npx --no-install tsx "$ROOT/scripts/context.mjs" "$@"
