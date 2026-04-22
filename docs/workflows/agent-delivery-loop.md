# Agent Delivery Loop

This repository treats delivery as a sequence of explicit agent roles instead of one long, vague coding session.

## Roles

- Implementation agent: reads the task context, makes the smallest coherent change, and validates locally.
- Review agent: reviews the branch against `main` and lists findings first.
- Merge agent: enables GitHub auto-merge only when the PR is actually ready.
- Human: resolves ambiguity, product judgment, or policy questions when the repo cannot encode them yet.

## Happy Path

1. Update or create an execution plan in `docs/exec-plans/active/`.
2. Prompt the implementation agent with the exact files it must read first.
3. Implement the smallest coherent change.
4. Run `./scripts/preflight.sh`.
5. Run a self-review pass using the checked-in review prompt.
6. Fix findings and rerun `./scripts/preflight.sh`.
7. Generate a PR body with `./scripts/prepare_pr.sh`.
8. Open the pull request.
9. Run an independent review agent against the PR or branch.
10. If the PR is ready, add the `agent/automerge` label and run `./scripts/enable_automerge.sh`.

## One-Command Runner

For plans that are already fully specified, use the local runner instead of triggering each phase manually:

```bash
./scripts/run_task.sh 0002
```

or:

```bash
npm run task -- 0002
```

The runner executes:

1. implementation
2. self-review
3. fix loop
4. PR preparation
5. merge readiness check

It relies on the execution plan being complete enough to act as the source of truth.

Useful variants:

```bash
./scripts/run_task.sh 0002 --phase implement
./scripts/run_task.sh 0002 --phase review
./scripts/run_task.sh 0002 --phase prepare-pr
./scripts/run_task.sh 0002 --phase merge-check
./scripts/run_task.sh 0002 --local-only
./scripts/run_task.sh 0002 --dry-run
```

Operational notes:

- Start from a clean working tree when switching from `main` to a task branch.
- The runner writes logs and phase outputs under `.task-runs/<task-id>/`.
- If GitHub auth or remote access is unavailable, the runner degrades to local-only mode instead of failing the whole task.

## Merge Agent Contract

The merge agent should only enable auto-merge when all of the following are true:

- The PR is not a draft.
- The implementation agent already ran `./scripts/preflight.sh`.
- The PR body includes validation, risks, and follow-ups.
- No unresolved critical or medium-severity review findings remain.
- The PR has the `agent/automerge` label.

The merge agent should not merge by force. It should add the label and run `./scripts/enable_automerge.sh <number>`. That script merges immediately with `gh pr merge --squash --delete-branch` when required checks are already green, and otherwise leaves the labeled PR for the GitHub workflow to merge as soon as CI finishes successfully.

## GitHub Requirements

- The `CI` workflow must run on pull requests.
- The `Agent Auto-Merge` workflow must run on labeled pull requests and successful CI completions.
- The `agent/automerge` label should exist in the repo.
- Branch protection on `main` should require the final PR checks once the check names are stable.

## Standard Commands

Implementation agent:

```bash
./scripts/preflight.sh
./scripts/prepare_pr.sh > /tmp/agently-pr.md
gh pr create --fill --body-file /tmp/agently-pr.md
```

Review agent:

```text
Review this branch against main.

Prioritize:
- bugs
- behavior regressions
- missing tests
- architecture violations
- docs drift

List findings first, ordered by severity, with file references.
If there are no findings, say that explicitly.
```

Merge agent:

```bash
gh pr edit <number> --add-label agent/automerge
./scripts/enable_automerge.sh <number>
```

## Failure Handling

When an agent fails repeatedly, the next task is to add the missing capability instead of repeating the same prompt. The fix usually falls into one of four buckets:

- Missing structure: add a spec, plan, prompt template, or workflow doc.
- Missing enforcement: add a lint, validator, CI rule, or branch rule.
- Missing visibility: add logs, tests, traces, or screenshots.
- Missing abstraction: add a helper, interface, or clearer boundary.
