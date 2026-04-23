#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_NUMBER="${1:-}"

cd "$ROOT"

if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER="$(gh pr view --json number --jq '.number')"
fi

# Tolerate already-merged PRs. Both the local merge-check phase and the
# remote Agent Auto-Merge workflow call this script; whichever wins
# the race to `gh pr merge` succeeds, the loser sees state=MERGED and
# would otherwise try to merge again and fail with "Merge already in
# progress (mergePullRequest)". Exit 0 on MERGED so the caller's run
# is not poisoned by a benign race.
STATE="$(gh pr view "$PR_NUMBER" --json state --jq '.state')"
if [[ "$STATE" == "MERGED" ]]; then
  echo "PR #$PR_NUMBER is already merged."
  exit 0
fi
if [[ "$STATE" == "CLOSED" ]]; then
  echo "PR #$PR_NUMBER is closed (not merged); refusing to auto-merge."
  exit 1
fi

IS_DRAFT="$(gh pr view "$PR_NUMBER" --json isDraft --jq '.isDraft')"
if [[ "$IS_DRAFT" == "true" ]]; then
  echo "PR #$PR_NUMBER is still a draft."
  exit 1
fi

HAS_LABEL="$(gh pr view "$PR_NUMBER" --json labels --jq '.labels[].name' | grep -Fx 'agent/automerge' || true)"
if [[ -z "$HAS_LABEL" ]]; then
  echo "PR #$PR_NUMBER is missing the agent/automerge label."
  exit 1
fi

REVIEW_DECISION="$(gh pr view "$PR_NUMBER" --json reviewDecision --jq '.reviewDecision // "UNREVIEWED"')"
if [[ "$REVIEW_DECISION" == "CHANGES_REQUESTED" ]]; then
  echo "PR #$PR_NUMBER still has requested changes."
  exit 1
fi

# Evaluate CI state by looking at the rollup directly and excluding the
# Agent Auto-Merge workflow itself — otherwise this script races against
# its own workflow's in-progress check run and incorrectly reports
# "pending" every time labeling triggers the workflow.
FAILED="$(gh pr view "$PR_NUMBER" --json statusCheckRollup \
  --jq '[.statusCheckRollup[]
    | select((.workflowName // "") != "Agent Auto-Merge")
    | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT"
             or .conclusion=="CANCELLED" or .conclusion=="STARTUP_FAILURE"
             or .conclusion=="ACTION_REQUIRED" or .conclusion=="STALE")]
    | length')"

PENDING="$(gh pr view "$PR_NUMBER" --json statusCheckRollup \
  --jq '[.statusCheckRollup[]
    | select((.workflowName // "") != "Agent Auto-Merge")
    | select(.status=="IN_PROGRESS" or .status=="QUEUED"
             or .status=="PENDING" or .status=="WAITING"
             or .status=="REQUESTED")]
    | length')"

SUCCESSFUL="$(gh pr view "$PR_NUMBER" --json statusCheckRollup \
  --jq '[.statusCheckRollup[]
    | select((.workflowName // "") != "Agent Auto-Merge")
    | select(.conclusion=="SUCCESS")]
    | length')"

if (( FAILED > 0 )); then
  echo "CI checks are failing for PR #$PR_NUMBER."
  gh pr checks "$PR_NUMBER" || true
  exit 1
fi

if (( PENDING > 0 )); then
  echo "CI checks are still pending for PR #$PR_NUMBER."
  echo "Leaving the agent/automerge label in place so the GitHub workflow can merge when CI finishes."
  exit 0
fi

if (( SUCCESSFUL == 0 )); then
  echo "No CI checks found for PR #$PR_NUMBER; refusing to merge."
  exit 1
fi

echo "CI checks are green. Merging PR #$PR_NUMBER..."
gh pr merge "$PR_NUMBER" --squash --delete-branch
