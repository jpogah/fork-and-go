#!/usr/bin/env -S node --experimental-strip-types
// Cost estimator (plan 0052). Reads aggregated token counts — either from the
// orchestrator's cumulative budget file or from a specific plan's .task-runs
// directory — and prints a human-readable cost summary using the @fork-and-go/
// run-budget rate card.
//
// Usage:
//   ./scripts/estimate-cost.mjs budget [--state-dir <dir>]
//   ./scripts/estimate-cost.mjs plan <planId> [--task-runs-dir <dir>]
//   ./scripts/estimate-cost.mjs          # defaults to `budget`
//
// Output is JSON by default (machine-readable); add `--pretty` for a
// human-friendly summary.
//
// The shebang passes `--experimental-strip-types` so Node can import the
// `@fork-and-go/run-budget` package's `.ts` source directly on Node <23.6 /
// <22.18. `env -S` splits the arg list so the flag reaches node.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBudget, scanPlanRuns } from "../packages/run-budget/src/index.ts";

const argv = process.argv.slice(2);
const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const defaultStateDir = path.join(repoRoot, ".orchestrator");
const defaultTaskRunsDir = path.join(repoRoot, ".task-runs");

function readFlag(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(name) {
  return argv.includes(name);
}

function printResult(result) {
  if (hasFlag("--pretty")) {
    const lines = [];
    lines.push(`Tokens: ${result.tokens}`);
    lines.push(`Estimated cost (USD cents): ${result.costCents}`);
    lines.push(`Estimated cost (USD): $${(result.costCents / 100).toFixed(2)}`);
    if (result.tokenCeiling !== undefined) {
      lines.push(`Ceiling: ${result.tokenCeiling}`);
      const pct = result.tokenCeiling
        ? Math.round((result.tokens / result.tokenCeiling) * 100)
        : 0;
      lines.push(`Fraction of ceiling: ${pct}%`);
    }
    if (result.resetAt) lines.push(`Resets at: ${result.resetAt}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "budget";

if (command === "budget") {
  const stateDir = readFlag("--state-dir") ?? defaultStateDir;
  const state = loadBudget({ dir: stateDir });
  printResult({
    mode: "budget",
    tokens: state.tokensUsed,
    costCents: state.costCentsEstimated,
    tokenCeiling: state.tokenCeiling,
    resetAt: state.resetAt,
  });
} else if (command === "plan") {
  const planId = argv[1];
  if (!planId || planId.startsWith("--")) {
    process.stderr.write("usage: estimate-cost.mjs plan <planId>\n");
    process.exit(2);
  }
  const taskRunsDir = readFlag("--task-runs-dir") ?? defaultTaskRunsDir;
  const scan = scanPlanRuns({ taskRunsDir, planId });
  printResult({
    mode: "plan",
    planId,
    tokens: scan.usage.totalTokens,
    inputTokens: scan.usage.inputTokens,
    outputTokens: scan.usage.outputTokens,
    costCents: scan.usage.costCents,
    byModel: scan.usage.byModel,
    byPhase: scan.usage.byPhase,
  });
} else {
  process.stderr.write(
    `unknown command: ${command}\n` +
      "usage: estimate-cost.mjs [budget|plan <planId>] [--pretty]\n",
  );
  process.exit(2);
}
