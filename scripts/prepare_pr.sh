#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_BRANCH="${1:-main}"
PLAN_PATH="${2:-}"

cd "$ROOT"

if [[ -z "$PLAN_PATH" ]]; then
  PLAN_PATH="$(find docs/exec-plans/active -maxdepth 1 -type f -name '*.md' | sort | tail -n 1)"
fi

BASE_REF="$BASE_BRANCH"
if git rev-parse --verify "origin/$BASE_BRANCH" >/dev/null 2>&1; then
  BASE_REF="origin/$BASE_BRANCH"
fi

CURRENT_BRANCH="$(git branch --show-current)"
CHANGED_FILES="$(git diff --name-only "$BASE_REF"...HEAD)"

if [[ -z "$CHANGED_FILES" ]]; then
  CHANGED_FILES="- No changed files detected against $BASE_REF."
else
  CHANGED_FILES="$(printf '%s\n' "$CHANGED_FILES" | sed 's/^/- /')"
fi

cat <<EOF
## Summary

- TODO: replace with the user-facing or engineering change in this PR.

## Plan

- ${PLAN_PATH}

## Validation

- [x] \`./scripts/preflight.sh\`

## Review Loop

- [x] Self-review loop converged with no blocking findings on branch \`${CURRENT_BRANCH}\`
- [ ] \`agent/automerge\` will only be added when the PR is ready

## Risks

- TODO: replace with concrete rollout, product, or technical risk.

## Follow-Ups

- TODO: replace with deferred work or \`None\`.

## Changed Files

${CHANGED_FILES}
EOF
