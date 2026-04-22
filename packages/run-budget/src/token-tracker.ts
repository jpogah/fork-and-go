// Aggregates per-phase `tokens-used.json` records into a cumulative delta the
// orchestrator can fold into `.orchestrator/budget.json`.
//
// Runner-side (scripts/run_task.sh) appends a JSON line per agent invocation
// to `.task-runs/<planId>/<runId>/tokens-used.json`. The file is written as
// NDJSON (newline-delimited JSON) so concurrent appends don't corrupt each
// other and partial lines from a crashed write are easy to skip.
//
// Aggregation is stateless: the orchestrator reads all tokens-used.json files
// for a plan, applies the delta, then records the files it has consumed in
// the per-plan tracking state so the next run doesn't double-count.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { estimateCostCents } from "./pricing.ts";

// One line in `tokens-used.json`. Not all agents will fill every field —
// `phase` is required so we can attribute tokens back to a phase, `model`
// defaults to "unknown" so the fallback rate applies.
export interface TokensUsedRecord {
  readonly phase: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  // Optional — when present, aggregation takes the runner's costCents at
  // face value instead of recomputing from the rate card. Lets a runner that
  // has real invoice data win over the estimator.
  readonly costCents?: number;
  // ISO timestamp of the write. Optional; defaults to the file mtime.
  readonly at?: string;
}

export interface AggregatedUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCents: number;
  readonly recordCount: number;
  readonly byModel: Readonly<Record<string, number>>;
  readonly byPhase: Readonly<Record<string, number>>;
}

export const TOKENS_USED_FILENAME = "tokens-used.json";

export function emptyUsage(): AggregatedUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    recordCount: 0,
    byModel: {},
    byPhase: {},
  };
}

// Parse a tokens-used.json file. Tolerant: invalid lines are skipped (a
// half-flushed write from a crashed runner should not make the orchestrator
// throw on its next tick).
export function parseTokensUsedFile(filePath: string): TokensUsedRecord[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: TokensUsedRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const input = Number(obj.inputTokens);
    const output = Number(obj.outputTokens);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input < 0 || output < 0) continue;
    const phase = typeof obj.phase === "string" ? obj.phase : "unknown";
    const model = typeof obj.model === "string" ? obj.model : "unknown";
    const record: TokensUsedRecord = {
      phase,
      model,
      inputTokens: input,
      outputTokens: output,
      ...(typeof obj.costCents === "number" && Number.isFinite(obj.costCents)
        ? { costCents: obj.costCents }
        : {}),
      ...(typeof obj.at === "string" ? { at: obj.at } : {}),
    };
    out.push(record);
  }
  return out;
}

export function aggregateRecords(
  records: Iterable<TokensUsedRecord>,
): AggregatedUsage {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costCents = 0;
  let recordCount = 0;
  const byModel: Record<string, number> = {};
  const byPhase: Record<string, number> = {};
  for (const record of records) {
    recordCount += 1;
    const rowTokens = record.inputTokens + record.outputTokens;
    totalTokens += rowTokens;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    costCents +=
      record.costCents ??
      estimateCostCents(record.model, {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      });
    byModel[record.model] = (byModel[record.model] ?? 0) + rowTokens;
    byPhase[record.phase] = (byPhase[record.phase] ?? 0) + rowTokens;
  }
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    costCents: Math.round(costCents * 100) / 100,
    recordCount,
    byModel,
    byPhase,
  };
}

export interface ScanPlanRunsOptions {
  // Directory under the repo root where per-plan runs live. Defaults to
  // `.task-runs`.
  taskRunsDir: string;
  planId: string;
  // Record identifiers already consumed (stored by the orchestrator). Any
  // tokens-used.json file whose identifier is in this set is skipped.
  consumed?: ReadonlySet<string>;
}

export interface ScanResult {
  readonly usage: AggregatedUsage;
  readonly consumedIds: readonly string[];
}

// Walk every run directory for a plan and aggregate unconsumed token files.
// Returns the identifiers of the files that were consumed so the caller can
// persist them to avoid double-counting. Identifier format is
// `<planId>/<runId>/<filename>` — stable, human-readable, and globally
// unique across plans so a single shared `consumed` set can be used.
export function scanPlanRuns(opts: ScanPlanRunsOptions): ScanResult {
  const planDir = path.join(opts.taskRunsDir, opts.planId);
  let runDirs: string[];
  try {
    runDirs = readdirSync(planDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          // Skip the `latest` symlink and anything that isn't a run dir.
          /^\d{8}-\d{6}$/.test(d.name),
      )
      .map((d) => d.name);
  } catch {
    return { usage: emptyUsage(), consumedIds: [] };
  }
  const records: TokensUsedRecord[] = [];
  const newlyConsumed: string[] = [];
  for (const runId of runDirs) {
    const filePath = path.join(planDir, runId, TOKENS_USED_FILENAME);
    try {
      statSync(filePath);
    } catch {
      continue;
    }
    const id = `${opts.planId}/${runId}/${TOKENS_USED_FILENAME}`;
    if (opts.consumed?.has(id)) continue;
    const fileRecords = parseTokensUsedFile(filePath);
    if (fileRecords.length === 0) continue;
    records.push(...fileRecords);
    newlyConsumed.push(id);
  }
  return {
    usage: aggregateRecords(records),
    consumedIds: newlyConsumed,
  };
}
