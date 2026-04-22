# Merge Readiness Prompt

Review this pull request for merge readiness.

## Gate

Approve the merge path only when **all** of these material conditions hold, as observed via `gh` and the diff:

- The PR is not a draft.
- All CI checks on the PR's latest commit have completed successfully. This includes the `e2e` workflow defined in `.github/workflows/e2e.yml`; a red e2e check is a hard block.
- The merge-check invocation has produced an `e2e-verify.out.md` inside its own `$RUN_DIR` (the exact `.task-runs/<task-id>/<run-id>/e2e-verify.out.md` path is templated into this prompt at write time). Its **first non-empty line must be exactly** `E2E verification passed.`. Do not read from `.task-runs/<id>/latest/` — that symlink moves with every `run_task.sh` invocation and is not a reliable witness for this run. If the sentinel is missing, refuse the merge path and point the operator at the templated artifact path. For plans explicitly tagged as non-UI-touching and run with `--skip-e2e`, no `e2e-verify.out.md` is produced; cite the opt-out in the PR body instead.
- The diff against the base branch does not introduce any Critical, High, or Medium-severity issues as defined in `docs/prompts/self-review.md`.
- The PR body is structurally complete — `## Summary`, `## Validation`, `## Risks`, and `## Follow-Ups` are all present and non-placeholder.
- No human reviewer has requested changes (`reviewDecision != CHANGES_REQUESTED`).

## What Not to Gate On

- The wording or checked/unchecked state of items inside the PR body's **Review Loop** section. The runner's `prepare-pr` phase ticks `Self-review loop converged with no blocking findings` when the self-review loop converged, and leaves `agent/automerge` unchecked by design. Treat those items as informational; do not re-flag them here.
- The absence of independent human reviews in an agent-first workflow. The self-review loop plus this merge-readiness review is the review process.

## Output Rules

- If findings exist, list them first, ordered by severity, with file references where applicable.
- If the PR is ready, start the response with exactly `No findings. Ready to enable auto-merge.`
- If ready, direct the merge agent to run `./scripts/enable_automerge.sh <pr-number>`.
