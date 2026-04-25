# Customize for your fork

Fork-and-Go is a harness, not a template you can use unmodified. The runner, prompts, and conventions transfer; a few scripts, one package, and one scaffold are project-shaped and need to be tuned for your stack.

This doc lists what to review before your first `./scripts/run_task.sh` run.

---

## Required

### E2E test infrastructure (for any fork shipping UI or a web service)

The harness's `e2e-verify` phase runs `npm run e2e` at the repo root and expects a working browser-automation test suite. If your fork will ship any UI-touching plan, this infrastructure **must** be wired before the first plan runs — otherwise the first plan's e2e-verify phase fails with `Missing script: "e2e"` (recent versions of `run_task.sh` surface this as an actionable scaffold-gap error pointing back at this doc).

The upstream harness assumes Playwright + a dedicated dev server on port 3100. If you want the canonical setup, run the bootstrap script shipped with this harness:

```bash
./scripts/bootstrap-e2e.sh
```

That script installs `@playwright/test` + chromium, writes `apps/web/playwright.config.ts`, lays down a heavy-smoke test suite at `apps/web/tests/e2e/smoke.spec.ts`, wires `e2e` + `e2e:install` scripts into both `apps/web/package.json` and the workspace root, and runs the suite once to verify. Idempotent — safe to re-run.

If your fork uses a different browser-automation framework (Cypress, Puppeteer, WebDriver), the contract is the same: `npm run e2e` must exit 0 when the product's acceptance criteria render correctly in a real browser, non-zero otherwise. The harness's e2e-verify phase captures the Playwright-style `playwright-report/` directory by convention; if you use a different framework, either keep that directory name for artifact capture or patch `scripts/run_task.sh` to look at your framework's report path.

For CLI-only or pure-library forks that never ship a UI, the right move is to skip e2e-verify per-plan via `--skip-e2e` in `run_task.sh`, and to tag the plan's frontmatter as `phase: "Harness"` (or similar non-UI phase). The e2e-verify gate is only enforced when a plan opts in.

### `scripts/preflight.sh`

The upstream version calls `npm run check` — a monorepo script that runs docs validation, formatter, linter, typechecker, tests, and build in sequence. Replace with your project's equivalent:

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Running repository preflight checks..."

./scripts/plan-graph.sh validate        # keep — validates plan frontmatter
# Replace with your stack's checks:
# npm run check        # Node monorepo
# cargo test && cargo clippy       # Rust
# pytest && ruff check .       # Python
# make test lint       # Makefile-driven
```

Preflight is called from `--phase prepare-pr` and `--phase all`. A red preflight blocks the PR from opening.

### `scripts/doctor.sh`

Intentionally not shipped in this repo — it's project-specific (your env vars, your docker setup, your dev services). Write your own from the template below:

```bash
#!/usr/bin/env bash
# scripts/doctor.sh — pre-flight check that the operator's environment is set up.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; }
pass() { echo "PASS: $1"; }

# Required env vars — replace with yours
[[ -n "${DATABASE_URL:-}" ]] && pass "DATABASE_URL set" || fail "DATABASE_URL not set"
[[ -n "${YOUR_APP_KEY:-}" ]] && pass "YOUR_APP_KEY set" || fail "YOUR_APP_KEY not set"

# Required tooling
command -v node >/dev/null && pass "node in PATH" || fail "node not installed"
command -v gh   >/dev/null && pass "gh in PATH"   || fail "gh CLI not installed"
```

### `scripts/validate_repo_docs.py`

The upstream version has a `REQUIRED_FILES` list checking for files like `apps/web/package.json`, workspace package names, and project-specific conventions. Not shipped here — write your own if you want repo-structure preflight.

Minimum viable:

```python
#!/usr/bin/env python3
# scripts/validate_repo_docs.py — repo-structure and convention guard
import sys
from pathlib import Path

REQUIRED = [
    "AGENTS.md",
    "ARCHITECTURE.md",
    "docs/HARNESS_ENGINEERING.md",
    "docs/prompts/self-review.md",
    "docs/prompts/merge-readiness.md",
    "docs/exec-plans/execution-plan-template.md",
    "scripts/run_task.sh",
    ".github/pull_request_template.md",
]

root = Path(__file__).resolve().parent.parent
missing = [p for p in REQUIRED if not (root / p).exists()]
if missing:
    for p in missing: print(f"MISSING: {p}", file=sys.stderr)
    sys.exit(1)
print("Repository workflow docs validation passed.")
```

Call it from preflight.

---

## The planner and the fidelity checker

Two capabilities from the Tier-1 harness-engineering arc now ship as generic harness packages:

- **The planner agent** (spec → plan sequence) lives in `packages/planner/` + `scripts/plan.{sh,ts}`. It takes a product spec and emits an ordered sequence of executable plans.
- **The spec-fidelity checker** lives in `packages/fidelity-check/` + `scripts/check-fidelity.{sh,ts}`. It periodically audits whether the harness's delivered work matches the product spec and can auto-suspend active plans on drift.

Both use the generic `@fork-and-go/model-client` model-client package. The default backend shells out through the Codex CLI; set `FORK_AND_GO_LLM_CLIENT=openai` and `OPENAI_API_KEY` to use the OpenAI backend.

---

## Optional

### `AGENTS.md` and `ARCHITECTURE.md`

Write these for your fork. `AGENTS.md` is a short table-of-contents for the harness and points at the other docs. `ARCHITECTURE.md` is a one-page map of your project's packages, apps, and key flows. The reviewer and merge-check agents read both.

### First reference plan

Copy `docs/exec-plans/execution-plan-template.md` into `docs/exec-plans/active/0001-your-first-feature.md` and write a real plan. This is your integration test — if the harness can merge your first plan, it works on your stack.

### The orchestrator daemon

`apps/orchestrator/` ships as a long-running Node process that polls for merges, resolves the next-eligible plan from the plan graph, and invokes `./scripts/run_task.sh` unattended. Use it once the shell-chain invocation feels like it's costing too much of your attention; you can operate without it until then.

Start the daemon with `./scripts/orchestrator.sh start`, send control commands via its local HTTP endpoint (default port 4500), and consult `.orchestrator/state.json` for the current run state.

### The release gate

`packages/release-gate/` + `scripts/release-gate.{sh,ts}` define top-level acceptance criteria for "the product is done" — release-level conditions that plans' `acceptance_tags` satisfy. Use it for multi-plan arcs (fork-and-go projects) where you want a mechanical stopping rule for the orchestrator. Skip it for standalone repos where each plan is its own unit.

### GitHub Actions auto-merge

`.github/workflows/agent-automerge.yml` is ready to go. Required repo settings:

- **Allow squash merging** (Settings → General → Pull Requests).
- A label named `agent/automerge` (the workflow creates it on first use, or create manually).
- Branch protection on `main` requiring the checks the workflow expects.

---

## Things that transfer as-is

You do **not** need to modify:

- `scripts/run_task.sh`, `scripts/run_task_loop.sh`, `scripts/prepare_pr.sh`, `scripts/enable_automerge.sh`
- `scripts/plan-graph.sh`, `scripts/plan-graph.ts`, `scripts/migrate-plans-to-frontmatter.mjs`
- `scripts/context.sh`, `scripts/context.mjs` (context-ingestion CLI)
- `scripts/release-gate.sh`, `scripts/release-gate.ts` (release-gate CLI)
- `scripts/orchestrator.sh` (orchestrator daemon CLI)
- `scripts/estimate-cost.mjs`, `scripts/budget-raise.mjs`, `scripts/agent-log.mjs`, `scripts/rate-limit-detect.mjs` (budget-governance CLIs)
- `packages/plan-graph/`, `packages/context-ingest/`, `packages/release-gate/`, `packages/run-budget/` (install their deps: `npm install` at the repo root, which uses the root workspace config)
- `apps/orchestrator/`
- `docs/prompts/*.md`
- `docs/workflows/agent-delivery-loop.md`
- `docs/exec-plans/execution-plan-template.md`
- `.github/pull_request_template.md`
- `.github/workflows/agent-automerge.yml`
- `docs/HARNESS_ENGINEERING.md` — though if you write your own field notes, replace it; this one is the original author's journal.

---

## Your first run

1. Install deps: `npm install` at the repo root (the workspace config picks up `packages/*` and `apps/*`).
2. Make sure `tsx` is available: `npm install -g tsx` or use the root workspace `tsx` dep.
3. Write `scripts/doctor.sh` and run it.
4. Write a plan at `docs/exec-plans/active/0001-your-first-feature.md`.
5. `./scripts/run_task.sh 0001 --skip-e2e` (skip e2e until you've wired a dev server).
6. Watch it go.

If anything breaks, open an issue. That's the field-report loop — friction becomes durable fixes for the next fork.
