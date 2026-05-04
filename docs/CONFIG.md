# `harness.config` reference

Each target repo commits a `harness.config.json` (or `harness.config.ts` / `.mts` / `.js` / `.mjs`) at its root. The harness reads this on every invocation. Env vars (`HARNESS_*`) override individual fields.

The schema is defined in [`packages/harness-config/src/schema.ts`](../packages/harness-config/src/schema.ts) (Zod). Validation errors are reported with field paths.

## Minimum viable config

```json
{
  "agent": { "provider": "claude" }
}
```

Everything else has a sensible default. With nothing more than this, the harness will:
- Read plans from `docs/exec-plans/active`
- Migrate completed plans to `docs/exec-plans/completed`
- Write its state to `.orchestrator/`
- Open PRs against `main`
- Drive the agent through Claude

## Full schema

```ts
{
  // Plan-graph paths (target repo, relative to repo root).
  planDir:       string,    // default "docs/exec-plans/active"
  completedDir:  string,    // default "docs/exec-plans/completed"
  contextDir?:   string,    // optional context-drop folder, e.g. "docs/context"

  // Where the harness writes its own state. Auto-gitignored on first run.
  stateDir:      string,    // default ".orchestrator"

  // Repo-relative or absolute directories the fidelity-check agent
  // should walk when assembling context. Replaces the old hardcoded
  // `apps/web/app` + `packages/`.
  appPaths:      string[],  // default ["src"]

  // The branch the runner compares + opens PRs against.
  baseBranch:    string,    // default "main"

  agent: {
    provider:    "claude" | "codex",
    model?:      string,                // SDK default if omitted
    maxReviewPasses?: number,           // default 5
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh",
  },

  // Provider used for "complete" mode (planner / fidelity-check /
  // site-reverse JSON output). Defaults to whatever `agent.provider` is.
  modelClient: {
    provider?:   "claude" | "codex",
    model?:      string,
  },

  // Required by the review-ui phase only.
  devServer?: {
    command: string,                    // e.g. "npm run dev"
    url:     string,                    // e.g. "http://localhost:3000"
    readyTimeoutSec?: number,           // default 60
  },

  // Required by the e2e-verify gate. When omitted, the e2e gate fails
  // with an actionable scaffold-gap message; --skip-e2e bypasses it.
  e2e?: {
    command:      string,               // e.g. "npm run e2e"
    artifactDirs: string[],             // e.g. ["playwright-report", "test-results"]
  },

  budget?: {
    ceilingTokens?: number,             // soft warning, not a hard pause
  },

  releaseGate?: {
    specPath: string,                   // sibling to product spec, e.g. "docs/product-specs/<name>.acceptance.md"
  },

  fidelity?: {
    specPath:    string,                // product spec the auditor scores against
    everyNPlans?: number,               // default 0 (disabled)
  },
}
```

## Examples

### Next.js app with Playwright e2e

```json
{
  "agent": { "provider": "claude", "maxReviewPasses": 5 },
  "appPaths": ["src/app", "src/components", "src/lib"],
  "devServer": {
    "command": "npm run dev",
    "url": "http://localhost:3000"
  },
  "e2e": {
    "command": "npm run e2e",
    "artifactDirs": ["playwright-report", "test-results"]
  },
  "fidelity": {
    "specPath": "docs/product-specs/main.md",
    "everyNPlans": 5
  },
  "releaseGate": {
    "specPath": "docs/product-specs/main.acceptance.md"
  }
}
```

### Codex agent on a Python service

```json
{
  "agent": { "provider": "codex", "reasoningEffort": "medium" },
  "appPaths": ["src", "tests"],
  "baseBranch": "develop",
  "e2e": {
    "command": "uv run pytest tests/e2e",
    "artifactDirs": ["test-results"]
  }
}
```

### TypeScript config (programmatic)

`harness.config.ts` may export a function that returns the config — useful when you want to read env vars or compute paths.

```ts
import type { HarnessConfigInput } from "@harness/config";

const config: HarnessConfigInput = {
  agent: {
    provider: process.env.NODE_ENV === "production" ? "claude" : "codex",
  },
  baseBranch: "main",
  appPaths: ["src"],
};
export default config;
```

## Env-var overrides

These take precedence over any field in the config file. Useful for CI overrides or operator-driven one-shots.

| Env var                          | Field overridden                  |
| -------------------------------- | --------------------------------- |
| `HARNESS_TARGET_REPO`            | (target repo path; not in schema) |
| `HARNESS_AGENT_PROVIDER`         | `agent.provider`                  |
| `HARNESS_AGENT_MODEL`            | `agent.model`                     |
| `HARNESS_AGENT_MAX_REVIEW_PASSES`| `agent.maxReviewPasses`           |
| `HARNESS_MODEL_CLIENT_PROVIDER`  | `modelClient.provider`            |
| `HARNESS_MODEL_CLIENT_MODEL`     | `modelClient.model`               |
| `HARNESS_PLAN_DIR`               | `planDir`                         |
| `HARNESS_COMPLETED_DIR`          | `completedDir`                    |
| `HARNESS_CONTEXT_DIR`            | `contextDir`                      |
| `HARNESS_STATE_DIR`              | `stateDir`                        |
| `HARNESS_BASE_BRANCH`            | `baseBranch`                      |
| `BUDGET_CEILING_TOKENS`          | `budget.ceilingTokens`            |

## Path resolution

All path fields are repo-relative by default; absolute paths are honored as-is. Resolution helpers are exported from `@harness/config`:

```ts
import { resolvePaths, loadHarnessConfig } from "@harness/config";

const config = await loadHarnessConfig(repoRoot);
const paths = resolvePaths(repoRoot, config);
// paths.planDir, paths.stateDir, paths.appPaths[*] are absolute.
```

## What happens on first run

The runner writes a `.gitignore` containing `*` into `stateDir` on first invocation. This makes the state dir self-ignoring so its contents never trip the runner's "working tree must be clean" guard. Target repos do **not** need to add `.orchestrator/` to their top-level `.gitignore`.
