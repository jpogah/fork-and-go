// Top-level orchestration: context build -> audit LLM -> score -> report
// write -> optional auto-suspension. One pass, no retries beyond the
// audit's internal repair — the CLI wraps this and translates outcomes
// to exit codes.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { BUILDER_DEFAULT_MODEL, BUILDER_REPAIR_MODEL } from "@fork-and-go/builder";
import type { ModelClient } from "@fork-and-go/builder";

import { audit } from "./audit.ts";
import { buildContext, FidelityContextError } from "./context-builder.ts";
import { loadFidelityPrompts, type FidelityPrompts } from "./prompts.ts";
import {
  writeReport,
  type WriteReportResult,
  type FidelitySummary,
} from "./report-writer.ts";
import {
  computeDrift,
  DEFAULT_THRESHOLD,
  type DriftComputation,
} from "./score.ts";
import type { AuditOutput } from "./schemas.ts";
import { suspendForFidelityReview, type SuspendResult } from "./suspend.ts";

export interface RunFidelityOptions {
  specPath: string;
  activeDir: string;
  completedDir: string;
  reportsDir: string;
  repoRoot: string;
  threshold?: number;
  autoSuspend?: boolean;
  now?: () => Date;
}

export interface RunFidelityDeps {
  modelClient: ModelClient;
  prompts?: FidelityPrompts;
  defaultModel?: string;
  repairModel?: string;
  maxRepairAttempts?: number;
}

export type RunFidelityOutcome =
  | {
      ok: true;
      score: number;
      threshold: number;
      exceedsThreshold: boolean;
      output: AuditOutput;
      computation: DriftComputation;
      summary: FidelitySummary;
      report: WriteReportResult;
      suspension: SuspendResult | null;
    }
  | {
      ok: false;
      stage: "context" | "audit" | "report";
      reason: string;
    };

export async function runFidelityCheck(
  options: RunFidelityOptions,
  deps: RunFidelityDeps,
): Promise<RunFidelityOutcome> {
  const now = options.now ?? (() => new Date());
  const nowDate = now();
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const previousSummaryPath = findPreviousSummary(
    options.reportsDir,
    slugFromSpec(options.specPath),
  );

  let context;
  try {
    context = buildContext({
      specPath: options.specPath,
      activeDir: options.activeDir,
      completedDir: options.completedDir,
      repoRoot: options.repoRoot,
      ...(previousSummaryPath !== null ? { previousSummaryPath } : {}),
    });
  } catch (err) {
    if (err instanceof FidelityContextError) {
      return { ok: false, stage: "context", reason: err.message };
    }
    throw err;
  }

  const prompts = deps.prompts ?? loadFidelityPrompts();
  const defaultModel = deps.defaultModel ?? BUILDER_DEFAULT_MODEL;
  const repairModel = deps.repairModel ?? BUILDER_REPAIR_MODEL;

  const auditResult = await audit(context, {
    modelClient: deps.modelClient,
    systemPrompt: prompts.audit,
    defaultModel,
    repairModel,
    ...(deps.maxRepairAttempts !== undefined
      ? { maxRepairAttempts: deps.maxRepairAttempts }
      : {}),
  });
  if (!auditResult.ok) {
    return { ok: false, stage: "audit", reason: auditResult.reason };
  }

  const computation = computeDrift(auditResult.output);
  const report = writeReport(context, auditResult.output, computation, {
    reportsDir: options.reportsDir,
    specSlug: context.spec.slug,
    now: nowDate,
    threshold,
    ...(previousSummaryPath ? { previousSummaryPath } : {}),
  });
  const summary: FidelitySummary = summaryFromReport(
    context,
    auditResult.output,
    computation,
    threshold,
    nowDate,
  );

  let suspension: SuspendResult | null = null;
  if (options.autoSuspend !== false && computation.score > threshold) {
    suspension = suspendForFidelityReview({
      activeDir: options.activeDir,
      completedDir: options.completedDir,
      summary,
      reportMarkdownPath: report.markdownPath,
      reportSummaryPath: report.summaryPath,
      now: nowDate,
    });
  }

  return {
    ok: true,
    score: computation.score,
    threshold,
    exceedsThreshold: computation.score > threshold,
    output: auditResult.output,
    computation,
    summary,
    report,
    suspension,
  };
}

function slugFromSpec(specPath: string): string {
  return path.basename(specPath, path.extname(specPath)).toLowerCase();
}

function findPreviousSummary(reportsDir: string, slug: string): string | null {
  if (!existsSync(reportsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return null;
  }
  const suffix = `-${slug}.json`;
  const matches = entries.filter((name) => name.endsWith(suffix)).sort();
  if (matches.length === 0) return null;
  return path.join(reportsDir, matches[matches.length - 1]!);
}

function summaryFromReport(
  context: ReturnType<typeof buildContext>,
  output: AuditOutput,
  computation: DriftComputation,
  threshold: number,
  nowDate: Date,
): FidelitySummary {
  return {
    generatedAt: nowDate.toISOString(),
    specSlug: context.spec.slug,
    specPath: context.spec.path,
    threshold,
    exceedsThreshold: computation.score > threshold,
    score: computation.score,
    totalRequirements: computation.totalRequirements,
    metCount: computation.metCount,
    partialCount: computation.partialCount,
    unmetCount: computation.unmetCount,
    driftCount: computation.driftCount,
    riskScore: computation.riskScore,
    breakdown: computation.breakdown,
    unmet: output.requirements
      .filter((r) => r.status === "unmet")
      .map((r) => ({ requirement: r.requirement, notes: r.notes })),
    drift: output.drift.map((d) => ({
      plan_id: d.plan_id,
      title: d.title,
      rationale: d.rationale,
    })),
    risks: output.risks.map((r) => ({
      level: r.level,
      category: r.category,
      detail: r.detail,
    })),
  };
}
