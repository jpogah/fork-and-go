// Budget manager. Wraps the @fork-and-go/run-budget primitives with the
// orchestrator-specific concerns: picking up the default ceiling from env,
// aggregating tokens per-plan on completion, computing the per-plan warning
// threshold, and surfacing a snapshot for `GET /status`.

import path from "node:path";

import {
  applyDelta,
  isCeilingReached,
  loadBudget,
  PER_PLAN_TOKENS_PER_PASS,
  saveBudget,
  scanPlanRuns,
  type AggregatedUsage,
  type BudgetState,
} from "@fork-and-go/run-budget";

export interface BudgetManagerOptions {
  stateDir: string;
  taskRunsDir: string;
  now?: () => Date;
  // Applied only on first-time file creation. Subsequent reads respect the
  // persisted value so operator raises survive restart.
  defaultCeilingTokens?: number;
  windowMs?: number;
}

export interface BudgetSnapshot {
  tokenCeiling: number;
  tokensUsed: number;
  costCentsEstimated: number;
  resetAt: string;
  ceilingReached: boolean;
}

export interface PlanAggregationResult {
  usage: AggregatedUsage;
  state: BudgetState;
  ceilingReached: boolean;
  // Non-zero when the plan consumed more than estimated_passes * 200k tokens.
  // Caller emits the `plan_over_budget` warning when this is > 0.
  overBudgetBy: number;
}

export interface BudgetManager {
  snapshot(): BudgetSnapshot;
  isCeilingReached(): boolean;
  // Scans `.task-runs/<planId>/` for any tokens-used.json files that haven't
  // been consumed yet, folds them into the budget, and returns both the
  // aggregated usage (so the caller can log it) and whether the ceiling has
  // just been crossed. Also returns a non-zero `overBudgetBy` value when the
  // plan's consumed tokens exceed `estimatedPasses * 200_000`.
  aggregatePlan(planId: string, estimatedPasses: number): PlanAggregationResult;
  raiseCeiling(newCeiling: number): BudgetState;
}

export function createBudgetManager(opts: BudgetManagerOptions): BudgetManager {
  const nowFn = opts.now ?? (() => new Date());

  const load = (): BudgetState =>
    loadBudget({
      dir: opts.stateDir,
      now: nowFn,
      ...(opts.defaultCeilingTokens !== undefined
        ? { defaultCeiling: opts.defaultCeilingTokens }
        : {}),
      ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    });

  return {
    snapshot() {
      const state = load();
      return {
        tokenCeiling: state.tokenCeiling,
        tokensUsed: state.tokensUsed,
        costCentsEstimated: state.costCentsEstimated,
        resetAt: state.resetAt,
        ceilingReached: isCeilingReached(state),
      };
    },
    isCeilingReached() {
      return isCeilingReached(load());
    },
    aggregatePlan(planId, estimatedPasses) {
      const existing = load();
      const consumed = new Set(existing.consumedTokenFiles);
      const scan = scanPlanRuns({
        taskRunsDir: opts.taskRunsDir,
        planId,
        consumed,
      });
      const next = applyDelta(
        existing,
        {
          tokens: scan.usage.totalTokens,
          costCents: scan.usage.costCents,
          consumedFileIds: scan.consumedIds,
        },
        nowFn(),
      );
      saveBudget(opts.stateDir, next);
      const perPlanBudget =
        Math.max(1, estimatedPasses) * PER_PLAN_TOKENS_PER_PASS;
      const overBudgetBy =
        scan.usage.totalTokens > perPlanBudget
          ? scan.usage.totalTokens - perPlanBudget
          : 0;
      return {
        usage: scan.usage,
        state: next,
        ceilingReached: isCeilingReached(next),
        overBudgetBy,
      };
    },
    raiseCeiling(newCeiling) {
      const existing = load();
      const next = {
        ...existing,
        tokenCeiling: Math.floor(newCeiling),
        lastUpdatedAt: nowFn().toISOString(),
      } satisfies BudgetState;
      saveBudget(opts.stateDir, next);
      return next;
    },
  };
}

// Resolve the task-runs directory from the repo root. Centralized so tests
// and the daemon never disagree on the convention.
export function defaultTaskRunsDir(repoRoot: string): string {
  return path.join(repoRoot, ".task-runs");
}
