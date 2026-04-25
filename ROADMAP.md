# Roadmap

Fork-and-Go ships in staged releases. Each release corresponds to a plan in `docs/exec-plans/active/` — executed by the harness itself, merged through its own loop.

Read the "North Star" and "Capability gap" sections of [`docs/HARNESS_ENGINEERING.md`](docs/HARNESS_ENGINEERING.md) for the long-term vision.

---

## v0.1 — The harness as shipped

**Released: [date]**

What's in this repo today:

- **Plan schema + dependency graph** (`packages/plan-graph/`, `scripts/plan-graph.sh`). YAML frontmatter validator, resolver, topological ordering, `PLANS.md` generator, drift check.
- **Phase runner** (`scripts/run_task.sh`, `scripts/run_task_loop.sh`): implement / review / fix / prepare-pr / e2e-verify / merge-check, with the rescue primitive for non-convergent loops.
- **Phase prompts** (`docs/prompts/`): feature-implementation, self-review, fix-review-findings, prepare-pr, merge-readiness — the five role definitions the harness runs on.
- **Orchestrator daemon** (`apps/orchestrator/` + `scripts/orchestrator.sh`): persistent plan-graph state, rate-limit-aware backoff, pause/resume/stop/freeze via local HTTP endpoint, PR-merge polling.
- **Context ingestion** (`packages/context-ingest/` + `scripts/context.{sh,mjs}`): `docs/context/` drop folder with scope grammar (run / planner / phase / all), prompt-injection-aware rendering, file-cap and priority management.
- **Budget governance** (`packages/run-budget/` + `scripts/estimate-cost.mjs`, `scripts/budget-raise.mjs`, `scripts/agent-log.mjs`, `scripts/rate-limit-detect.mjs`): token tracking across Claude/Codex agent invocations, rate-limit detection in agent logs, configurable per-run/per-product ceilings, daemon freeze-on-ceiling.
- **Release gate** (`packages/release-gate/` + `scripts/release-gate.{sh,ts}`): top-level acceptance-criteria definition, plan-acceptance-tag cross-reference, orchestrator stopping rule.
- **Generic builder client** (`packages/builder/`): harness-level model-client package with Codex CLI and OpenAI backends.
- **Planner agent** (`packages/planner/` + `scripts/plan.{sh,ts}`): product spec to ordered execution plans, idempotent across re-runs.
- **Spec-fidelity checker** (`packages/fidelity-check/` + `scripts/check-fidelity.{sh,ts}`): spec drift audit, report writing, and active-plan suspension when drift crosses threshold.
- **GitHub Actions auto-merge workflow** (`.github/workflows/agent-automerge.yml`): label-triggered squash-merge gated on CI.
- **The field journal** (`docs/HARNESS_ENGINEERING.md`) — 1,200+ lines of notes on what broke and what fixed it, traceable to specific plan incidents.

**Validated against:** 60+ merged PRs on a production SaaS. The full Tier-1 harness-engineering arc (plans 0048 through 0054) shipped through the harness's own loop in a single day on April 22, 2026.

See [`CUSTOMIZE.md`](CUSTOMIZE.md) for what to tune before your first run.

---

## v0.2 — Planner + fidelity checker + builder-client extraction

*Shipped into this repo after the Agently-specific model-client dependency was extracted.*

- **Builder-client package extraction.** Factor the Agently product's model wrapper into generic `@fork-and-go/builder`, used by planner, fidelity-check, and future harness-level agents. Support Codex CLI by default and OpenAI via environment variables.
- **Planner agent** (`packages/planner/` + `scripts/plan.sh`): takes a product spec (free-form markdown in `docs/product-specs/`), analyzes the current repo state, emits a sequence of execution plan files conforming to the 0048 frontmatter schema. Idempotent on re-run.
- **Spec-fidelity checker** (`packages/fidelity-check/` + `scripts/check-fidelity.sh`): periodic audit of delivered work against the original product spec. Auto-suspension of active plans when drift score exceeds configurable threshold. Orchestrator hook to fire every N merges.
- **Documented planner calibration.** Against multiple spec shapes (brief specs, verbose specs, structured specs).

---

## v0.3 — Agent adapter infrastructure

*Target: after v0.2 lands and has exercised the planner against 3-5 external forks' spec shapes.*

The harness is agent-agnostic by design; `scripts/run_task.sh` already has an `--agent codex|claude` flag. v0.3 hardens the adapter surface:

- **Clean adapter interface** — formalize what a new agent adapter has to provide (phase invocation, tool scoping, output parsing, sentinel recognition).
- **Codex adapter** as a reference second implementation.
- **Community adapter scaffolding** — template for adding Cursor agent mode, Aider, Continue, or other agents.
- **Cross-agent consistency tests** — a minimum fixture suite that adapters must pass.

---

## v0.4+ — Spec-to-spec communication and the 10-hour unattended bar

*Target: once v0.2 and v0.3 have cycled through external forks.*

- **Spec-to-spec communication** (open research question — no architecture yet). The machinery by which two Fork-and-Go projects running against different products can share learnings and primitives without a human copying them over.
- **Demonstrated 10-hour unattended run.** Calibrated end-to-end against multiple plan classes, with the orchestrator daemon absorbing rate-limit backoff, host-sleep recovery, and upstream-model-version changes mid-run.
- **Release-gate calibration for greenfield products.** Documented end-to-end fork-and-go run from spec to shipped product, operated by a user who did not write any of the intermediate plans by hand.

---

## What's explicitly out of scope

From the north-star vision in `docs/HARNESS_ENGINEERING.md`, two categories will always require a human:

- **Tool unblocking** — OAuth consent, paying real money, revoking a live grant at a third party, signing binding legal terms. The agent pauses and emits a concise *"I need X to continue"* artifact. Target: minutes of human time, not hours.
- **Real judgment calls** — *"Should this be $49 or $69?"*, *"Which vertical ships first?"*, *"Brand: editorial or playful?"* The agent frames the question and waits.

---

## Community plans

External forks can propose plans that feed back into the core harness. Proposals go through the same execution-plan shape (`docs/exec-plans/execution-plan-template.md`). A plan that lands in two or more forks and produces a generalizable primitive becomes a candidate for upstream.

The harness is MIT. Fork it, ship against it, and let us know what broke.
