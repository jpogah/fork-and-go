#!/usr/bin/env node
// Raise the per-product token ceiling in .orchestrator/budget.json (plan 0052).
// Invoked by `./scripts/orchestrator.sh budget raise <n>`. Exists as a
// standalone helper because the orchestrator daemon may be paused (and thus
// unable to accept a control-server call) when the operator is unblocking it.
//
// Usage: budget-raise.mjs <new-ceiling> <state-dir>

import {
  loadBudget,
  saveBudget,
  withCeiling,
} from "../packages/run-budget/src/index.ts";

const [, , newCeilingStr, stateDir] = process.argv;
if (!newCeilingStr || !stateDir) {
  process.stderr.write("usage: budget-raise.mjs <new-ceiling> <state-dir>\n");
  process.exit(2);
}

const newCeiling = Number(newCeilingStr);
if (!Number.isFinite(newCeiling) || newCeiling <= 0) {
  process.stderr.write(
    `new ceiling must be a positive number, got ${JSON.stringify(newCeilingStr)}\n`,
  );
  process.exit(2);
}

const state = loadBudget({ dir: stateDir });
const next = withCeiling(state, newCeiling, new Date());
saveBudget(stateDir, next);
process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      tokenCeiling: next.tokenCeiling,
      tokensUsed: next.tokensUsed,
    },
    null,
    2,
  ) + "\n",
);
