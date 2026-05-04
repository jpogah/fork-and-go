# Harness Engineering

A living record of how this harness is designed, why it's shaped the way it is, and how it gets used. The audience is the next person fixing or extending it.

> An older long-form version of this doc (with a sample product's history) lives in git history before the repo became repo-agnostic. If you need the historical narrative — the lessons that justified each decision — read commits prior to the rewrite.

---

## North star

A contributor hands the harness a high-level product spec, and the harness plans, implements, verifies, and ships the product with a human in the loop only where a human adds real value.

The vision is **minimal-human, not zero-human.** Three roles a human still owns:

1. **Context provider.** The agent's knowledge comes from the repo. Anything outside the repo — a Slack thread, a legal email, a customer pain point — has to flow into the agent's working set. The harness accepts free-form context drops at `<contextDir>/` and routes them per phase.
2. **Tool unblocker.** The agent can't complete OAuth consent screens, sign legal terms, or move real money. When it needs one of those, it pauses and emits a concise "I need X to continue" artifact. Target: minutes of human time, not hours.
3. **Clarifier and tie-breaker.** Real judgment calls — pricing, scope, brand voice — go to a human. The harness must distinguish "needs judgment" from "agent can decide" and only interrupt for the former.

The measurable outcome: **the agent works for 10+ hours without human intervention** on a well-specified product.

---

## Three foundational claims

1. **The repo is the system of record.** Plans, prompts, prompts-about-prompts, quality scores, audit trail — all in version control. If a decision only exists in chat, it does not exist.
2. **Every phase is a separate role.** Implementer, reviewer, planner, fidelity-checker, release-gate — different prompts, different tool permissions, different expected outputs. Role separation is where quality comes from.
3. **Friction belongs in mechanical checks.** Every piece of advice you'd give twice should become a lint, a test, a validator, or a runner guard. Repeated human corrections are a harness failure.

---

## Architecture (as of this rewrite)

The harness is a TypeScript monorepo. Every harness role goes through `@harness/agent-runner`, which wraps the official Claude Agent SDK and Codex SDK. There are **no direct API calls anywhere** — no `openai` Chat Completions, no `@anthropic-ai/sdk` Messages — and **no CLI subprocesses** for agent invocation.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          target repo                                 │
│  harness.config.{json,ts}                                            │
│  <planDir>/<NNNN>-<slug>.md      ← plan files                        │
│  <completedDir>/<NNNN>-<slug>.md ← migrated on PR-merge              │
│  <contextDir>/<phase>.md         ← human context drops               │
│  <stateDir>/                     ← runner artifacts (gitignored)     │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ harness CLI (--repo or HARNESS_TARGET_REPO)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          harness repo                                │
│  apps/orchestrator/                                                  │
│    src/cli.ts                    ← `harness run|daemon|plan|fidelity`│
│    src/runner/                   ← in-process task runner            │
│      index.ts                    ← runTask({ taskRef, repoRoot, ... })│
│      phases.ts                   ← implement/review/fix/prepare-pr/.. │
│      prompts.ts, sentinels.ts                                        │
│      git.ts, dev-server.ts                                           │
│    src/daemon.ts                 ← long-running watcher              │
│    src/control-server.ts         ← /pause /resume /stop /freeze ...  │
│    src/state.ts, src/budget.ts, src/merge-detector.ts                │
│                                                                      │
│  packages/                                                           │
│    agent-runner/   ← Claude Agent SDK + Codex SDK wrapper            │
│    harness-config/ ← Zod schema + loader for harness.config.{json,ts}│
│    planner/        ← spec → plan agent                               │
│    fidelity-check/ ← drift-audit agent                               │
│    release-gate/   ← acceptance-criteria checker                     │
│    plan-graph/     ← plan loader + dependency resolver               │
│    run-budget/     ← token tracking, rate-limit detect, freeze       │
│    context-ingest/ ← context-drop ingestion                          │
│    site-reverse/   ← URL → product-spec capture                      │
└──────────────────────────────────────────────────────────────────────┘
```

### The two cuts

**Cut 1 — repo boundary.** The harness has no opinion about the target repo's layout. Every path (planDir, completedDir, appPaths, stateDir) is read from `harness.config.{json,ts}`. The harness binary is run *from* the harness repo but *operates on* a target repo identified by `--repo <path>` or `HARNESS_TARGET_REPO`. See `docs/CONFIG.md` for the schema.

**Cut 2 — agent boundary.** Every harness role is an agent invocation through `@harness/agent-runner`. The runner exposes three modes:
- `exec` — full tools, file edits, command execution. Used by implement, fix, prepare-pr.
- `review` — read-only repo access. Used by review, review-ui, merge-check, fidelity.
- `complete` — single-turn, no tools (by default). Used by planner JSON output, site-reverse analysis.

Both providers (`claude`, `codex`) implement all three modes. Switching providers is a config flag — no code changes.

See `docs/AGENT_RUNNER.md` for the full API.

---

## The loop

A plan moves through these phases. Operators run a single phase with `harness run <id> --phase <name>`, or chain them all with `--phase all` (the default).

```
       ┌──────── plan (<planDir>/NNNN-*.md) ────────┐
       │                                            │
       ▼                                            │
 ┌──────────┐    ┌────────┐    ┌─────┐    ┌─────────┐│
 │implement │───▶│ review │───▶│ fix │───▶│preflight│┘
 └──────────┘    └────────┘ ◀──┴─────┘    └─────────┘
                     │  "No blocking findings."
                     ▼
              ┌─────────────┐    ┌──────────┐
              │ prepare-pr  │───▶│ open PR  │
              └─────────────┘    └──────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ wait for CI     │
                              │ + e2e-verify    │
                              └─────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ merge-readiness │
                              │ → label + merge │
                              └─────────────────┘
```

`run_task.sh` and `run_task_loop.sh` (the bash predecessors) are gone; the entire loop is `runTask()` in TypeScript, called either by the operator (one-shot) or by the daemon (long-running watcher).

### Why each phase is its own agent role

- **Implementer** writes code. Bypasses tool prompts. Sees the plan + delivery loop docs.
- **Reviewer** reads the diff. Cannot edit. Different prompt, different severity rubric, different output sentinel (`No findings.` / `No blocking findings.`).
- **Fixer** is the implementer again, but its prompt prepends review findings as a directive.
- **Preparer** turns the diff + plan into a PR body. Strict output format (Markdown body only).
- **Merge-checker** gates auto-merge. Read-only. Output sentinel: `No findings. Ready to enable auto-merge.`

Different prompts. Different permissions. Different convergence criteria. Quality comes from the role separation, not the model.

---

## Convergence: severity tiers + sentinels

Reviewers find *something* on every pass without a severity floor. Without a sentinel, the loop never terminates.

- Four severities: **Critical**, **High**, **Medium**, **Low**. Critical/High/Medium are blocking.
- Two sentinels recognized as "loop converged": `No findings.` and `No blocking findings.`
- Lows land in PR follow-ups, not in the next fix prompt — otherwise they'd resurface on every pass.

Default review-pass budget is `agent.maxReviewPasses: 5` (config-driven). Empirically: UI plans converge in 1–2; plans with security or auth surface need 4–6.

The sentinel parser is intentionally forgiving: the sentinel must be the first non-empty line *or* appear as a standalone line anywhere in the body. Models that emit a "verified invariants" preamble before the sentinel still trigger convergence. See `apps/orchestrator/src/runner/sentinels.ts`.

---

## E2E gate inside the review/fix loop

E2E lives inside the loop, not after it. Static review and e2e have different failure modes (hydration mismatches, browser-only races) and the agent should self-correct against both.

Each pass:
1. Run static review.
2. If review has blocking findings → feed to fix → next pass.
3. If review is clean → run e2e. Pass? Loop converges. Fail? Synthesize findings from the e2e log → feed to fix → next pass.

E2E artifacts (Playwright HTML report, test-results) are copied into `<stateDir>/task-runs/<plan>/<run>/e2e-verify/` so the merge-readiness reviewer can cite them.

The `e2e.command` and `e2e.artifactDirs` fields in `harness.config` make this repo-agnostic. Plans that genuinely don't touch the UI run with `--skip-e2e`.

---

## Daemon: long-running watcher

`harness daemon start` boots a tick loop that:
1. Polls `gh pr list` for newly merged PRs (the merge detector).
2. Picks the next eligible plan by walking the dependency graph.
3. Calls `runTask()` in-process. No subprocess.
4. On success, migrates the plan file from `<planDir>` to `<completedDir>` and pushes that as a `chore:` commit on `baseBranch`.
5. On rate-limit, sleeps `rateLimitBackoffMs` and retries (up to `maxRateLimitRetries` times). On other failure, marks the plan blocked and continues.
6. After every observed merge, optionally runs the release-gate hook. After every N merges, optionally runs the fidelity hook.

Operator surface (HTTP on `127.0.0.1:4500`):
- `GET /state` → snapshot
- `POST /pause` / `POST /resume` / `POST /stop`
- `POST /freeze` (refuses new runs, idempotent file sentinel)
- `POST /unfreeze`
- `POST /unblock/:id`

The daemon is observable from outside: state lives in `<stateDir>/state.json`, freeze sentinel at `<stateDir>/FROZEN`, per-plan logs at `<stateDir>/logs/<plan>-<run>.log`, token records at `<stateDir>/task-runs/<plan>/<run>/tokens-used.json`.

State persistence + checkpointed long plans + transient-failure resilience are what make 10-hour unattended runs possible. A SIGKILL between transitions leaves state.json consistent (atomic writer); the next boot resumes from `<stateDir>/state.json`'s `active` field.

---

## Budget and freeze

Per-product token ceiling lives at `config.budget.ceilingTokens` (or `BUDGET_CEILING_TOKENS` env). Hitting the ceiling logs `budget_ceiling_reached` but does **not** block — for CLI-auth (subscription) usage, tokens don't map to marginal cost, so a hard pause would be a false positive.

If you actually want a hard stop, use `harness daemon freeze` — the `<stateDir>/FROZEN` sentinel is checked at every tick and at the top of every `runTask()`. It's the only signal that halts mid-flight runs from the operator side.

---

## Spec fidelity

After every N merges (`config.fidelity.everyNPlans`), the daemon runs the fidelity-check agent. It reads the product spec, walks the resolved app paths, and asks the agent to score how far the as-built has drifted from the as-specified. Score above threshold → daemon auto-pauses with `fidelity_blocked` in history.

The check is its own agent role: read-only tools, structured JSON output, validated by Zod. See `packages/fidelity-check/`.

---

## Release gate

Acceptance-criteria checker. The product spec ships with a sibling `<spec>.acceptance.md` listing tagged criteria; the planner threads tags onto each plan; the gate verifies every criterion is covered by a completed plan. Configured via `config.releaseGate.specPath`.

When the gate passes after a merge, the daemon writes `<stateDir>/RELEASE_READY` and pauses. Failures are silent — "not ready yet" is the normal case.

---

## Why this shape

Three things drove the architecture:

- **Provider portability.** The harness should outlive any one model. Replacing the SDK is a config flag, not a rewrite. That forced the agent-runner abstraction.
- **Repo portability.** The harness is its own product. Coupling it to one target repo's layout meant every fork rewrote half the runner. That forced `harness.config.{json,ts}`.
- **Honest infrastructure.** Bash was hiding bugs behind exit codes and tee'd logs. Every "weird" daemon failure traced back to either a string-parse on stdout or a missing exit-code check on a piped command. Porting to TypeScript made these typed and visible.

Everything else — the sentinel parsers, the review/fix loop, the e2e gate, the freeze sentinel — earned its place by failing first in the bash version. The TypeScript port preserves them as named functions instead of string-matched stdout.

---

## Where to look when something breaks

| Symptom                                     | First file to read                                          |
| ------------------------------------------- | ----------------------------------------------------------- |
| Loop doesn't converge                       | `apps/orchestrator/src/runner/sentinels.ts`                 |
| Wrong agent provider / model                | `harness.config.{json,ts}` and `packages/harness-config/`   |
| Plan resolution fails                       | `apps/orchestrator/src/runner/index.ts:resolvePlan`         |
| Daemon never picks up next plan             | `apps/orchestrator/src/daemon.ts:pickNextEligiblePlan`      |
| Rate limit isn't backing off                | `packages/agent-runner/src/{claude,codex}-runner.ts`        |
| Fidelity check runs too often               | `config.fidelity.everyNPlans`                               |
| `harness run` fails with "tree not clean"   | `<stateDir>` not gitignored — runner writes a `.gitignore`  |
|                                             | with `*` into stateDir on first run; verify it landed       |
| Dev server won't start for review-ui        | `config.devServer.url` port already in use                  |

---

## Lessons (running record)

Append entries here when something non-obvious shows up. Keep them short; the code is the source of truth.

- **`<stateDir>/.gitignore` with `*`.** The runner writes `*` into the state dir's own `.gitignore` on first run. Without this, the state dir is untracked and trips the runner's "working tree must be clean" guard before the agent ever runs. Found by the very first integration test.
- **CompletionClient adapter, not direct SDK access.** Planner / fidelity / site-reverse historically took a `ModelClient` (OpenAI Chat Completions). They now take a `CompletionClient` from `@harness/agent-runner` that wraps `runner.complete()`. Same call shape, agent-SDK transport. The package boundary keeps the consumers stateless.
- **Agent runner factory rejects unknown providers at runtime.** Zod rejects unknown `provider` strings upstream, but the factory has a `never` exhaustiveness check anyway. When you add a third provider, both will complain in the right order.
