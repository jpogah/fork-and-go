// Drift score math.
//
// Formula (from plan 0053):
//   score = 0.5 * unmetPct + 2 * driftCount + 0.3 * riskScore
//
//   unmetPct  = 100 * (unmetCount + 0.5 * partialCount) / totalRequirements
//   driftCount = raw count of drift items
//   riskScore = LLM's self-reported risk (0–100)
//
// The result is clamped to [0, 100] and rounded to the nearest integer.
// `partial` requirements contribute half — the LLM may mark a requirement
// `partial` when a plan covers some but not all of it, and we don't want
// them to count for nothing.

import type { AuditOutput } from "./schemas.ts";

export const DEFAULT_THRESHOLD = 25;

export interface DriftComputation {
  score: number;
  unmetCount: number;
  partialCount: number;
  metCount: number;
  totalRequirements: number;
  unmetPct: number;
  driftCount: number;
  riskScore: number;
  breakdown: {
    unmetComponent: number;
    driftComponent: number;
    riskComponent: number;
  };
}

export function computeDrift(output: AuditOutput): DriftComputation {
  let met = 0;
  let partial = 0;
  let unmet = 0;
  for (const req of output.requirements) {
    if (req.status === "met") met += 1;
    else if (req.status === "partial") partial += 1;
    else unmet += 1;
  }
  const total = output.requirements.length;
  const unmetPct = total === 0 ? 0 : (100 * (unmet + 0.5 * partial)) / total;
  const driftCount = output.drift.length;
  const riskScore = clamp(output.risk_score, 0, 100);

  const unmetComponent = 0.5 * unmetPct;
  const driftComponent = 2 * driftCount;
  const riskComponent = 0.3 * riskScore;
  const raw = unmetComponent + driftComponent + riskComponent;
  const score = Math.round(clamp(raw, 0, 100));

  return {
    score,
    unmetCount: unmet,
    partialCount: partial,
    metCount: met,
    totalRequirements: total,
    unmetPct,
    driftCount,
    riskScore,
    breakdown: {
      unmetComponent,
      driftComponent,
      riskComponent,
    },
  };
}

export function exceedsThreshold(score: number, threshold: number): boolean {
  return score > threshold;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
