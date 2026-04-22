// Read/write `.orchestrator/budget.json`. Written atomically (temp+rename) to
// match the orchestrator's state.json durability guarantees — if the process
// crashes mid-write, readers either see the prior file or the new file,
// never a partial JSON payload.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const BUDGET_FILE_VERSION = 1 as const;

export const DEFAULT_TOKEN_CEILING = 5_000_000;
// Rolling 7-day window, locked by the plan. Consumers can override with a
// different ISO timestamp at write time if they want a different cadence.
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Per-plan over-budget warning threshold is `estimated_passes * this`.
export const PER_PLAN_TOKENS_PER_PASS = 200_000;

export interface BudgetState {
  readonly version: typeof BUDGET_FILE_VERSION;
  readonly tokenCeiling: number;
  readonly tokensUsed: number;
  readonly costCentsEstimated: number;
  readonly resetAt: string;
  // Tracked so a raise-then-reset preserves history; unused by the core math.
  readonly lastUpdatedAt: string;
  // Identifiers of the `tokens-used.json` files already folded into the
  // cumulative totals above. Used by the orchestrator's aggregator so a
  // restart-triggered re-scan can't double-count. Format:
  // `<planId>/<runId>/tokens-used.json`.
  readonly consumedTokenFiles: readonly string[];
}

export interface BudgetFileOptions {
  dir: string;
  now?: () => Date;
  // Defaults to DEFAULT_TOKEN_CEILING when the file is being created fresh.
  // Honored on creation only — subsequent reads respect the persisted value.
  defaultCeiling?: number;
  windowMs?: number;
}

export function budgetFilePath(dir: string): string {
  return path.join(dir, "budget.json");
}

export function emptyBudget(opts: {
  ceiling?: number;
  windowMs?: number;
  now: Date;
}): BudgetState {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  return {
    version: BUDGET_FILE_VERSION,
    tokenCeiling: opts.ceiling ?? DEFAULT_TOKEN_CEILING,
    tokensUsed: 0,
    costCentsEstimated: 0,
    resetAt: new Date(opts.now.getTime() + windowMs).toISOString(),
    lastUpdatedAt: opts.now.toISOString(),
    consumedTokenFiles: [],
  };
}

// Load the budget file, initializing it if absent. Window-reset logic: if
// `resetAt` is in the past, zero the counters and roll the window forward.
export function loadBudget(opts: BudgetFileOptions): BudgetState {
  const file = budgetFilePath(opts.dir);
  const nowFn = opts.now ?? (() => new Date());
  const now = nowFn();
  mkdirSync(opts.dir, { recursive: true });
  if (!existsSync(file)) {
    const fresh = emptyBudget({
      ceiling: opts.defaultCeiling,
      windowMs: opts.windowMs,
      now,
    });
    writeAtomic(file, fresh);
    return fresh;
  }
  const parsed = parseBudgetFile(readFileSync(file, "utf8"), file);
  // Rolling window: if we're past resetAt, counters zero out and resetAt
  // advances. The ceiling is preserved so operator-raises survive a reset.
  if (Date.parse(parsed.resetAt) <= now.getTime()) {
    const rolled: BudgetState = {
      ...parsed,
      tokensUsed: 0,
      costCentsEstimated: 0,
      resetAt: new Date(
        now.getTime() + (opts.windowMs ?? DEFAULT_WINDOW_MS),
      ).toISOString(),
      lastUpdatedAt: now.toISOString(),
      consumedTokenFiles: [],
    };
    writeAtomic(file, rolled);
    return rolled;
  }
  return parsed;
}

export function saveBudget(dir: string, state: BudgetState): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(budgetFilePath(dir), state);
}

export interface BudgetDelta {
  readonly tokens: number;
  readonly costCents: number;
  // Identifiers of tokens-used.json files that produced this delta. Merged
  // into `consumedTokenFiles` so a later re-scan skips them.
  readonly consumedFileIds?: readonly string[];
}

// Applies a delta produced by the token-tracker. Pure function — caller
// decides whether to save; tests exercise the math without touching disk.
export function applyDelta(
  state: BudgetState,
  delta: BudgetDelta,
  now: Date,
): BudgetState {
  const merged = delta.consumedFileIds
    ? Array.from(
        new Set([...state.consumedTokenFiles, ...delta.consumedFileIds]),
      )
    : state.consumedTokenFiles;
  return {
    ...state,
    tokensUsed: state.tokensUsed + delta.tokens,
    costCentsEstimated:
      Math.round((state.costCentsEstimated + delta.costCents) * 100) / 100,
    lastUpdatedAt: now.toISOString(),
    consumedTokenFiles: merged,
  };
}

export function isCeilingReached(state: BudgetState): boolean {
  return state.tokensUsed >= state.tokenCeiling;
}

export function withCeiling(
  state: BudgetState,
  newCeiling: number,
  now: Date,
): BudgetState {
  if (!Number.isFinite(newCeiling) || newCeiling <= 0) {
    throw new Error(
      `ceiling must be a positive finite number, got ${JSON.stringify(newCeiling)}`,
    );
  }
  return {
    ...state,
    tokenCeiling: Math.floor(newCeiling),
    lastUpdatedAt: now.toISOString(),
  };
}

function parseBudgetFile(text: string, filePath: string): BudgetState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`budget file at ${filePath} is not valid JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`budget file at ${filePath} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== BUDGET_FILE_VERSION) {
    throw new Error(
      `budget file version mismatch at ${filePath}: expected ${BUDGET_FILE_VERSION}, got ${JSON.stringify(obj.version)}`,
    );
  }
  return {
    version: BUDGET_FILE_VERSION,
    tokenCeiling: numericField(obj, "tokenCeiling", filePath),
    tokensUsed: numericField(obj, "tokensUsed", filePath),
    costCentsEstimated: numericField(obj, "costCentsEstimated", filePath),
    resetAt: stringField(obj, "resetAt", filePath),
    lastUpdatedAt: stringField(obj, "lastUpdatedAt", filePath),
    consumedTokenFiles: Array.isArray(obj.consumedTokenFiles)
      ? obj.consumedTokenFiles.filter((v): v is string => typeof v === "string")
      : [],
  };
}

function numericField(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `budget file at ${file} has invalid ${key}: ${JSON.stringify(v)}`,
    );
  }
  return v;
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new Error(
      `budget file at ${file} has invalid ${key}: ${JSON.stringify(v)}`,
    );
  }
  return v;
}

// Atomic write, same pattern as @fork-and-go/orchestrator's state writer.
function writeAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(tmp, payload, { encoding: "utf8" });
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Non-POSIX filesystems may refuse to open a directory for fsync.
  }
}
