#!/usr/bin/env bash
# Run `./scripts/run_task.sh <TASK_ID> --phase fix` repeatedly until the self-
# review converges, then ship the PR via prepare-pr + merge-check.
#
# Purpose: the main runner's `all` mode runs review/fix internally but a Claude
# rate-limit interruption mid-loop leaves the work stranded with no way to
# resume without redoing implementation. This script picks up from wherever the
# branch is on disk — implementation already done, some fix passes done, no
# commits needed between iterations — and drives convergence.
#
# The script detects the Claude usage-limit message and exits cleanly (exit
# code 2) so the operator can re-run after the limit resets without losing
# pass progress. MAX_PASSES caps total iterations (default 5, matching the
# main runner's MAX_REVIEW_PASSES).
#
# Usage:
#   ./scripts/run_task_loop.sh TASK_ID          # default MAX_PASSES=5
#   ./scripts/run_task_loop.sh TASK_ID 3        # cap at 3 passes
#   ./scripts/run_task_loop.sh TASK_ID 5 --skip-e2e
#
# Remaining args after TASK_ID / MAX_PASSES are forwarded to every
# run_task.sh invocation the loop makes.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 TASK_ID [MAX_PASSES] [-- extra run_task.sh args]" >&2
  exit 64
fi

TASK_ID="$1"
shift
MAX_PASSES="${1:-5}"
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then shift; fi
EXTRA_ARGS=("$@")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

latest_run_dir() {
  # Most-recent timestamped subdir under .task-runs/<task>/
  ls -1dt ".task-runs/$TASK_ID"/*/ 2>/dev/null | head -n1 | sed 's:/*$::'
}

# Mirror `review_is_clean` from run_task.sh — the first non-empty line must be
# exactly "No findings." or "No blocking findings.", with a defensive fallback
# that accepts the sentinel anywhere as a standalone line (handles reviewer
# preambles that slipped past the strict prompt).
is_clean_review() {
  local file="$1"
  [[ -s "$file" ]] || return 1
  local first
  first="$(awk 'NF {print; exit}' "$file" | tr -d '\r')"
  if [[ "$first" == "No findings."* ]] || [[ "$first" == "No blocking findings."* ]]; then
    return 0
  fi
  if grep -qE '^(No findings|No blocking findings)\.' "$file"; then
    return 0
  fi
  return 1
}

# Rate-limit detection. Delegates to @agently/run-budget via the
# scripts/rate-limit-detect.mjs wrapper so the regex lives in exactly one
# place (plan 0052). run_task.sh itself also calls the detector inline per
# agent phase and exits 2 with a WIP commit; this wrapper stays as a second
# gate so an older claude CLI that slips past the inline check still aborts
# the loop instead of burning the remaining pass budget.
has_rate_limit() {
  local file="$1"
  [[ -s "$file" ]] || return 1
  # `--experimental-strip-types` is required because rate-limit-detect.mjs
  # imports the shared detector's `.ts` source; without it, Node <23.6 / <22.18
  # fails with ERR_UNKNOWN_FILE_EXTENSION and the loop's safety-net detection
  # becomes a silent no-op (a regression of pre-0052 grep-based detection).
  node --experimental-strip-types "$ROOT/scripts/rate-limit-detect.mjs" "$file" >/dev/null 2>&1
}

for pass in $(seq 1 "$MAX_PASSES"); do
  echo ""
  echo "=== run_task_loop pass $pass of $MAX_PASSES (task $TASK_ID) ==="
  ./scripts/run_task.sh "$TASK_ID" --phase fix ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

  run_dir="$(latest_run_dir)"
  review_file="$run_dir/review.out.md"

  if has_rate_limit "$review_file"; then
    echo ""
    echo "!!! Claude usage limit detected in $review_file."
    echo "!!! Loop aborted at pass $pass. After the limit resets, resume with:"
    echo "    ./scripts/run_task_loop.sh $TASK_ID"
    exit 2
  fi

  if is_clean_review "$review_file"; then
    echo ""
    echo "=== Converged after $pass pass(es). ==="
    break
  fi
done

final_run_dir="$(latest_run_dir)"
final_review="$final_run_dir/review.out.md"
if ! is_clean_review "$final_review"; then
  echo ""
  echo "!!! Review did not converge within $MAX_PASSES passes."
  echo "!!! Inspect $final_review and either bump MAX_PASSES or address findings manually."
  exit 1
fi

echo ""
echo "=== Preparing PR for $TASK_ID ==="
./scripts/run_task.sh "$TASK_ID" --phase prepare-pr ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo ""
echo "=== Running merge-check for $TASK_ID ==="
# merge-check owns its own e2e-verify gate (per plan 0033), so no separate
# e2e-verify call is needed here.
./scripts/run_task.sh "$TASK_ID" --phase merge-check ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo ""
echo "=== Task $TASK_ID complete. ==="
