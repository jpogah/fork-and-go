# Fork-and-Go

**Agent-first delivery pipelines that ship while you're asleep.**

Fork-and-Go is an opinionated harness for running coding agents (Claude Code today, others next) through a full spec -> plan -> implement -> review -> fix -> PR -> merge loop. It can start from a human-written plan, a product spec, or a public URL that gets reverse-engineered into an improved rebuild spec.

> This is the scaffolding that shipped 30+ merged plans for a production SaaS. The harness is the product; the plans are the test suite.

Companion book: [*Agent-First Engineering: A Field Report on Shipping Software With AI Coding Agents*](https://www.amazon.com/dp/B0GYBLMY5L).

---

## What it does

Given a plan file in `docs/exec-plans/active/`, `./scripts/run_task.sh <plan-id>` will:

1. **Implement** — branch, write code, tests, migrations. Runs preflight.
2. **Review** — self-review with severity tiers (Critical / High / Medium / Low). Converges on a sentinel (`No blocking findings.`) or hits the pass budget.
3. **Fix** — apply the review findings by root cause. Re-run review until clean.
4. **Prepare PR** — generate a structured PR body, commit, push, open/update the PR.
5. **E2E verify** — boot the dev server, drive the UI via browser automation, assert acceptance criteria.
6. **Merge-check** — confirm CI green + no CHANGES_REQUESTED + PR body structural. Label `agent/automerge` and let GitHub Actions squash-merge.

Every phase runs as a separate `claude -p` (or `codex` — see Roadmap) subprocess with a phase-specific prompt, scoped tools, and a structured output contract.

---

## Who it's for

- Teams running an AI coding agent through pull requests today, hitting the same "the agent writes the code but someone still has to drive review, fix, commit, PR" friction.
- Open-source maintainers who want an auditable, forkable convention for agent-driven delivery — not another IDE plug-in.
- Anyone reaching for a 10-hour unattended run and hitting the state-persistence / rate-limit / convergence-budget walls.

If you just want a faster autocomplete: Cursor or Claude Code alone is enough. Fork-and-Go is for the orchestration around the agent.

---

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/<your-org>/fork-and-go.git my-project
cd my-project
./scripts/doctor.sh            # verifies deps, env, workspace

# 2. Write a plan
cp docs/exec-plans/execution-plan-template.md \
   docs/exec-plans/active/0001-my-first-feature.md
$EDITOR docs/exec-plans/active/0001-my-first-feature.md

# 3. Run it
./scripts/run_task.sh 0001
```

That's the whole UX. The runner handles branching, commits, PR, CI wait, auto-merge.

You can also start from a product spec or public website:

```bash
# Product spec -> executable plans
./scripts/plan.sh docs/product-specs/EXAMPLE.md --preview

# Public URL -> evidence bundle + improved rebuild spec + executable plans
npx playwright install chromium   # one-time browser install if needed
./scripts/reverse-site.sh https://online-video-cutter.com/ \
  --name video-cutter-rebuild \
  --planner-preview
```

---

## The opinionated parts

Fork-and-Go is opinionated where it matters:

- **Plans are contracts.** Each plan file is a structured Markdown doc with Goal / Locked Decisions / Scope / Acceptance Criteria / Out Of Scope. The runner reads them; the agent writes against them; the reviewer checks drift against them.
- **Severity-tiered self-review.** Critical / High / Medium block; Low ships as tracked follow-ups. The convergence sentinel `No blocking findings.` short-circuits the loop when nothing blocking remains.
- **Role-split agents.** The reviewer, fixer, PR-prepper, and merge-checker are separate invocations with separate prompts and separate tool scopes. The merge-check agent does **not** re-review code.
- **The PR body is generated, not improvised.** `## Summary / ## Validation / ## Risks / ## Follow-Ups` is a structural contract. Preflight drift-checks it.
- **Hooks earn their place from friction.** Every primitive in the harness came from a specific failure on a specific plan. See [`docs/HARNESS_ENGINEERING.md`](docs/HARNESS_ENGINEERING.md) for the field notes — 1,200+ lines of what we learned running this through real work.

---

## Why not just use Claude Code / Cursor / Devin?

| Tool | What it is | What it doesn't solve |
|---|---|---|
| **Claude Code** (CLI) | An agent. | Doesn't plan, doesn't split roles, doesn't gate merges. Each session is fresh. |
| **Cursor / Windsurf** | An IDE. | Great for interactive edits; not designed for unattended multi-hour runs. |
| **Devin** | A managed service. | Closed, expensive, no repo-local contract, no fork-and-go. |
| **Fork-and-Go** | The orchestration layer. | Brings your own agent (Claude Code today). Repo-local. Forkable. |

Fork-and-Go is not a replacement for Claude Code — it's the delivery harness *around* it. Pitch: **"Claude Code for the agent. Fork-and-Go for the pipeline."**

---

## The field notes

[`docs/HARNESS_ENGINEERING.md`](docs/HARNESS_ENGINEERING.md) is a living record of what we learned running this harness through real production work. It's the scholarship the scaffolding is built on — the "why" behind every primitive in `scripts/` and every rule in `docs/prompts/`.

If you're forking this harness, read that doc first. Read it again after your first three plans ship.

---

## What's in this repo

This repo ships the Tier-1 harness-engineering arc from the companion book — the full scaffolding that closed the demo-to-production gap on a real codebase:

- **Plan schema + dependency graph** (`packages/plan-graph/`, `scripts/plan-graph.sh`).
- **Phase runner with rescue primitive** (`scripts/run_task.sh`, `scripts/run_task_loop.sh`).
- **Orchestrator daemon** (`apps/orchestrator/` + `scripts/orchestrator.sh`) — persistent state, rate-limit backoff, pause/resume/stop controls.
- **Context ingestion** (`packages/context-ingest/` + `scripts/context.sh`) — `docs/context/` drop folder with scope grammar and prompt-injection defense.
- **Budget governance** (`packages/run-budget/` + cost/budget/rate-limit CLIs) — per-run and per-product token ceilings.
- **Release gate** (`packages/release-gate/` + `scripts/release-gate.sh`) — top-level acceptance criteria for "product is done."
- **Generic model client** (`packages/model-client/`) — a harness-level model client with Codex CLI and OpenAI backends.
- **Planner agent** (`packages/planner/` + `scripts/plan.sh`) — turns a product spec into ordered executable plans.
- **Site reverse-engineering** (`packages/site-reverse/` + `scripts/reverse-site.sh`) — captures a public URL with Playwright, generates an improved-rebuild product spec, stores source evidence, and hands the spec to the planner.
- **Spec-fidelity checker** (`packages/fidelity-check/` + `scripts/check-fidelity.sh`) — audits delivered work against the product spec and can suspend drifted active plans.
- **Five phase prompts** (`docs/prompts/`), **GitHub Actions auto-merge** (`.github/workflows/`), **1,200 lines of field notes** (`docs/HARNESS_ENGINEERING.md`).

## Roadmap

- **v0.2** Planner agent + spec-fidelity checker + generic model-client extraction + URL-to-app reverse-engineering.
- **v0.3** Agent adapter infrastructure (Codex, Aider, Cursor agent mode as reference adapters).
- **v0.4+** Spec-to-spec communication between forked harnesses; demonstrated 10-hour unattended run; greenfield fork-and-go end-to-end.

See [`ROADMAP.md`](ROADMAP.md) for the full schedule and the open research questions.

Each version ships against a plan in `docs/exec-plans/active/`, using the harness itself. The harness shipping itself is the integration test.

---

## License

MIT. See [`LICENSE`](LICENSE).

"Fork-and-Go" is a trademark of the project maintainer. You can build on the code, fork it, use it commercially — but please don't name your fork "Fork-and-Go".
