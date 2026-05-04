# harness

Repo-agnostic agent harness driven by the Claude Agent SDK and the Codex SDK. Point it at any target repo with a `harness.config.{json,ts}` and it plans, implements, reviews, and ships work autonomously.

> Live site: <https://jpogah.github.io/fork-and-go/>
> Docs: [Engineering notes](docs/HARNESS_ENGINEERING.md) · [Config reference](docs/CONFIG.md) · [Agent runner API](docs/AGENT_RUNNER.md)

## What's in the repo

- `apps/orchestrator/` — long-running daemon, run-loop, CLI binary (`harness`).
- `packages/agent-runner/` — single abstraction over `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Every harness role (implementer, reviewer, planner, fidelity-checker, release-gate) goes through this — no direct API calls anywhere.
- `packages/harness-config/` — Zod schema + loader for `harness.config.{json,ts}`. Drives every repo-specific path (plan dir, app paths, dev server command, base branch, etc.).
- `packages/planner/` — spec → plan decomposition agent.
- `packages/fidelity-check/` — drift auditor agent.
- `packages/release-gate/` — acceptance criteria checker.
- `packages/plan-graph/` — plan-file loader + dependency resolver.
- `packages/run-budget/` — token tracking, rate-limit detection, freeze sentinel.
- `packages/context-ingest/` — external context drop ingestion.
- `packages/site-reverse/` — URL → product-spec capture.
- `docs/HARNESS_ENGINEERING.md` — design notes.

## Quick start

In the **target repo** (the project the harness will work on), commit a `harness.config.json` at the root:

```json
{
  "agent": { "provider": "claude", "maxReviewPasses": 5 },
  "planDir": "docs/exec-plans/active",
  "completedDir": "docs/exec-plans/completed",
  "appPaths": ["src", "app"],
  "baseBranch": "main",
  "devServer": {
    "command": "npm run dev",
    "url": "http://localhost:3000"
  },
  "e2e": {
    "command": "npm run e2e",
    "artifactDirs": ["playwright-report", "test-results"]
  }
}
```

From the harness repo, point it at the target:

```bash
# One-shot: run a single plan to completion
HARNESS_TARGET_REPO=/path/to/target npm run harness -- run 0001 --phase all

# Long-running: start the daemon, watch for new plans + merges
HARNESS_TARGET_REPO=/path/to/target npm run harness -- daemon start
```

## CLI reference

```text
harness run <task-id-or-plan-path> [options]
  --phase <name>     all | implement | review | review-ui | fix |
                     prepare-pr | e2e-verify | merge-check (default: all)
  --local-only       Skip push, PR, and merge operations.
  --skip-e2e         Skip the e2e-verify gate.
  --dry-run          Log actions without invoking the agent or git.
  --resume           Re-enter the review/fix loop on the existing branch.

harness daemon <start|stop|freeze|unfreeze|status>
  Long-running watcher. POST/GET against :4500 once running.

harness plan <spec-file> [--preview] [--max-new-plans N]
  Decompose a product spec into plan files (planner agent in `complete` mode).

harness fidelity [--spec <path>] [--threshold N]
  Audit drift between the as-built product and the spec.

All commands accept --repo <path> (defaults to HARNESS_TARGET_REPO env var,
then process.cwd()).
```

## Configuration

Every repo-specific decision flows through `harness.config.{json,ts}` — paths, dev server, e2e command, agent provider, model overrides. Env vars (`HARNESS_AGENT_PROVIDER`, `HARNESS_AGENT_MODEL`, `HARNESS_PLAN_DIR`, etc.) override individual fields. Full schema lives in [`packages/harness-config/src/schema.ts`](packages/harness-config/src/schema.ts); narrative + examples in [`docs/CONFIG.md`](docs/CONFIG.md).

## Agent providers

- `claude` — uses `@anthropic-ai/claude-agent-sdk`. Requires Claude Code auth in the host environment.
- `codex` — uses `@openai/codex-sdk`. Requires Codex auth.

Both run **in-process**. There is no `claude` / `codex` CLI subprocess shelled out from the runner. Architecture and three-mode contract are documented in [`docs/AGENT_RUNNER.md`](docs/AGENT_RUNNER.md).

## Verified end-to-end

The runner has been validated against fresh fixture target repos with both providers:

| Provider | Plan                          | Outcome                  | Tokens (in/out) |
| -------- | ----------------------------- | ------------------------ | --------------- |
| `codex`  | Create `hello.txt`            | File created, validated  | 104,680 / 1,095 |
| `claude` | Create `hello-claude.txt`     | File created, validated  |      11 / 1,011 |

`tsc --noEmit` passes across all 10 workspaces. `vitest run` passes 319 tests across 47 files (includes runner integration tests against real temp git repos with stubbed agents).

## Layout

```
apps/orchestrator/
  src/cli.ts            # `harness` binary
  src/runner/           # in-process runTask + phases (replaces run_task.sh)
  src/daemon.ts         # long-running watcher
  src/control-server.ts # HTTP control surface
packages/
  agent-runner/         # SDK wrapper (claude + codex)
  harness-config/       # config loader + Zod schema
  planner/              # spec → plan agent
  fidelity-check/       # drift auditor agent
  release-gate/         # acceptance-criteria checker
  plan-graph/           # plan loader + dependency resolver
  run-budget/           # token + freeze + rate-limit
  context-ingest/       # context-drop ingestion
  site-reverse/         # URL → product-spec capture
docs/
  HARNESS_ENGINEERING.md # design notes
  CONFIG.md              # config reference
  AGENT_RUNNER.md        # SDK wrapper API
  index.html             # GitHub Pages landing
```

## License

MIT.
