// Report writer: takes the audit output + drift computation and emits a
// markdown report + machine-readable JSON summary under
// `.orchestrator/fidelity-reports/`. The two files share a basename so an
// operator can diff them side-by-side or wire them into a review UI.
//
// Dedup: if the previous summary JSON is structurally identical to this
// run's summary (same score, same counts, same requirement statuses),
// skip writing new files. The caller passes the previous summary path.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { FidelityContext } from "./context-builder.ts";
import type { DriftComputation } from "./score.ts";
import type { AuditOutput } from "./schemas.ts";

export interface WriteReportOptions {
  reportsDir: string;
  specSlug: string;
  now: Date;
  threshold: number;
  // Optional previous summary path used to dedup identical runs.
  previousSummaryPath?: string;
}

export interface WriteReportResult {
  markdownPath: string;
  summaryPath: string;
  skipped: boolean;
  skipReason?: string;
}

export interface FidelitySummary {
  generatedAt: string;
  specSlug: string;
  specPath: string;
  threshold: number;
  exceedsThreshold: boolean;
  score: number;
  totalRequirements: number;
  metCount: number;
  partialCount: number;
  unmetCount: number;
  driftCount: number;
  riskScore: number;
  breakdown: DriftComputation["breakdown"];
  unmet: ReadonlyArray<{ requirement: string; notes: string }>;
  drift: ReadonlyArray<{ plan_id: string; title: string; rationale: string }>;
  risks: ReadonlyArray<{ level: string; category: string; detail: string }>;
}

export function writeReport(
  context: FidelityContext,
  audit: AuditOutput,
  computation: DriftComputation,
  options: WriteReportOptions,
): WriteReportResult {
  mkdirSync(options.reportsDir, { recursive: true });

  const dateStr = options.now.toISOString().slice(0, 10);
  const baseName = `${dateStr}-${options.specSlug}`;
  const markdownPath = path.join(options.reportsDir, `${baseName}.md`);
  const summaryPath = path.join(options.reportsDir, `${baseName}.json`);

  const summary = buildSummary(context, audit, computation, options);

  if (options.previousSummaryPath) {
    const prev = readPreviousSummary(options.previousSummaryPath);
    if (prev && isSameAudit(prev, summary)) {
      // Return the previous run's paths — the current run's files were
      // never written, so downstream consumers (auto-suspension meta-plan)
      // must point the operator at the real on-disk report.
      const prevSummaryPath = options.previousSummaryPath;
      const prevMarkdownPath =
        prevSummaryPath.slice(0, -".json".length) + ".md";
      return {
        markdownPath: prevMarkdownPath,
        summaryPath: prevSummaryPath,
        skipped: true,
        skipReason: "identical to previous summary",
      };
    }
  }

  const markdown = renderMarkdown(summary, audit, computation, context);
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  return { markdownPath, summaryPath, skipped: false };
}

function buildSummary(
  context: FidelityContext,
  audit: AuditOutput,
  computation: DriftComputation,
  options: WriteReportOptions,
): FidelitySummary {
  return {
    generatedAt: options.now.toISOString(),
    specSlug: options.specSlug,
    specPath: context.spec.path,
    threshold: options.threshold,
    exceedsThreshold: computation.score > options.threshold,
    score: computation.score,
    totalRequirements: computation.totalRequirements,
    metCount: computation.metCount,
    partialCount: computation.partialCount,
    unmetCount: computation.unmetCount,
    driftCount: computation.driftCount,
    riskScore: computation.riskScore,
    breakdown: computation.breakdown,
    unmet: audit.requirements
      .filter((r) => r.status === "unmet")
      .map((r) => ({ requirement: r.requirement, notes: r.notes })),
    drift: audit.drift.map((d) => ({
      plan_id: d.plan_id,
      title: d.title,
      rationale: d.rationale,
    })),
    risks: audit.risks.map((r) => ({
      level: r.level,
      category: r.category,
      detail: r.detail,
    })),
  };
}

function readPreviousSummary(filePath: string): FidelitySummary | null {
  try {
    const text = readFileSync(filePath, "utf8");
    return JSON.parse(text) as FidelitySummary;
  } catch {
    return null;
  }
}

function isSameAudit(prev: FidelitySummary, next: FidelitySummary): boolean {
  // Treat two reports as identical iff everything that affects the operator
  // decision is the same. `generatedAt` is deliberately ignored — the
  // timestamp changes every run even when nothing else has.
  const keys = [
    "score",
    "totalRequirements",
    "metCount",
    "partialCount",
    "unmetCount",
    "driftCount",
    "riskScore",
  ] as const;
  for (const key of keys) {
    if (prev[key] !== next[key]) return false;
  }
  if (JSON.stringify(prev.unmet) !== JSON.stringify(next.unmet)) return false;
  if (JSON.stringify(prev.drift) !== JSON.stringify(next.drift)) return false;
  if (JSON.stringify(prev.risks) !== JSON.stringify(next.risks)) return false;
  return true;
}

function renderMarkdown(
  summary: FidelitySummary,
  audit: AuditOutput,
  computation: DriftComputation,
  context: FidelityContext,
): string {
  const statusIcon = summary.exceedsThreshold ? "⚠ OVER" : "✓ OK";
  const title = `# Spec Fidelity Report — ${summary.generatedAt.slice(0, 10)} — ${summary.specSlug}`;
  const header = [
    "",
    `## Drift Score: ${summary.score} / 100 (threshold: ${summary.threshold}) ${statusIcon}`,
    "",
    `- Requirements: ${computation.metCount} met, ${computation.partialCount} partial, ${computation.unmetCount} unmet (total ${computation.totalRequirements})`,
    `- Drift items: ${computation.driftCount}`,
    `- LLM risk score: ${computation.riskScore}`,
    `- Spec: \`${path.basename(context.spec.path)}\``,
    "",
  ];
  const requirementsSection = [
    "## Spec requirements",
    "",
    ...audit.requirements.map((r) => {
      const icon =
        r.status === "met" ? "✅" : r.status === "partial" ? "⚠" : "❌";
      const cite = r.plan_id ? ` — covered by ${r.plan_id}` : "";
      const note = r.notes ? ` (${r.notes})` : "";
      return `- ${icon} "${r.requirement}"${cite}${note}`;
    }),
    "",
  ];
  const driftSection = [
    "## Drift observed",
    "",
    audit.drift.length === 0
      ? "- None."
      : audit.drift
          .map((d) => `- "${d.title}" (plan ${d.plan_id}) — ${d.rationale}`)
          .join("\n"),
    "",
  ];
  const riskSection = [
    "## Risk assessment",
    "",
    audit.risks.length === 0
      ? "- None."
      : audit.risks
          .map(
            (r) =>
              `- **${r.level[0]!.toUpperCase()}${r.level.slice(1)}** (${r.category}): ${r.detail}`,
          )
          .join("\n"),
    "",
  ];
  const actionsSection = [
    "## Recommended actions",
    "",
    audit.recommended_actions.length === 0
      ? "- None."
      : audit.recommended_actions.map((a, i) => `${i + 1}. ${a}`).join("\n"),
    "",
  ];

  return [
    title,
    ...header,
    ...requirementsSection,
    ...driftSection,
    ...riskSection,
    ...actionsSection,
  ].join("\n");
}
