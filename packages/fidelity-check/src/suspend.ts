// Auto-suspension flow: when drift exceeds the threshold, mark every
// currently-active plan `blocked` and emit a meta-plan at
// `docs/exec-plans/active/9999-fidelity-review.md` that the operator must
// resolve before the orchestrator resumes. The 9999 prefix is reserved
// for auto-generated review plans — if one already exists we overwrite it
// with the latest report's details rather than churning a new id.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadPlans, setPlanStatus, type Plan } from "@fork-and-go/plan-graph";

import type { FidelitySummary } from "./report-writer.ts";

export const META_PLAN_ID = "9999";
export const META_PLAN_FILENAME = "9999-fidelity-review.md";

export interface SuspendOptions {
  activeDir: string;
  completedDir: string;
  summary: FidelitySummary;
  reportMarkdownPath: string;
  // Absolute path to the JSON summary, included in the meta-plan's body
  // so the operator can pull it into their review loop.
  reportSummaryPath: string;
  now: Date;
}

export interface SuspendResult {
  blockedPlanIds: string[];
  blockFailures: ReadonlyArray<{ planId: string; reason: string }>;
  metaPlanPath: string;
  metaPlanCreated: boolean;
  metaPlanUpdated: boolean;
}

export function suspendForFidelityReview(
  options: SuspendOptions,
): SuspendResult {
  const plans = loadPlans({
    activeDir: options.activeDir,
    completedDir: options.completedDir,
  });

  const targets = plans.filter(
    (plan) =>
      plan.location === "active" &&
      plan.id !== META_PLAN_ID &&
      plan.status !== "blocked" &&
      plan.status !== "completed",
  );
  const targetIds = targets.map((plan) => plan.id);

  // Write the meta-plan BEFORE flipping any plan statuses. If the process
  // crashes mid-loop, the review gate is already on disk and the operator
  // sees a clear "fidelity review required" signal instead of a silently
  // half-blocked active set with no paper trail.
  const metaPlanPath = path.join(options.activeDir, META_PLAN_FILENAME);
  const existed = existsSync(metaPlanPath);
  const body = renderMetaPlan(
    options.summary,
    options.reportMarkdownPath,
    options.reportSummaryPath,
    options.now,
    targetIds,
    plans,
  );
  writeFileSync(metaPlanPath, body, "utf8");

  const blocked: string[] = [];
  const failures: Array<{ planId: string; reason: string }> = [];
  // Per-plan try/catch so a single bad plan file can't poison the whole
  // run — the meta-plan is already on disk, so the operator still has a
  // visible review gate even if some blocks fail.
  for (const plan of targets) {
    try {
      const result = setPlanStatus(plan.filePath, "blocked");
      if (result.changed) blocked.push(plan.id);
    } catch (err) {
      failures.push({
        planId: plan.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    blockedPlanIds: blocked,
    blockFailures: failures,
    metaPlanPath,
    metaPlanCreated: !existed,
    metaPlanUpdated: existed,
  };
}

function renderMetaPlan(
  summary: FidelitySummary,
  reportMarkdownPath: string,
  reportSummaryPath: string,
  now: Date,
  targetIds: ReadonlyArray<string>,
  allPlans: ReadonlyArray<Plan>,
): string {
  const dateStr = now.toISOString().slice(0, 10);
  // depends_on can stay empty: the operator resolves this plan by hand.
  // Keeping it dependency-free means the graph validator never complains
  // even if the IDs the meta-plan refers to later change.
  const frontmatter = [
    "---",
    `id: "9999"`,
    `title: "Fidelity Review — ${summary.specSlug}"`,
    `phase: "Harness"`,
    `status: "active"`,
    `depends_on: []`,
    `estimated_passes: 1`,
    `acceptance_tags: []`,
    "---",
    "",
  ].join("\n");

  const blockedLines =
    targetIds.length === 0
      ? ["- No plans require blocking (all were already blocked or completed)."]
      : targetIds.map((id) => {
          const title = allPlans.find((p) => p.id === id)?.title ?? "";
          return `- ${id}${title ? ` — ${title}` : ""}`;
        });

  const unmetLines =
    summary.unmet.length === 0
      ? ["- None."]
      : summary.unmet.map(
          (u) => `- ${u.requirement}${u.notes ? ` (${u.notes})` : ""}`,
        );
  const driftLines =
    summary.drift.length === 0
      ? ["- None."]
      : summary.drift.map((d) => `- ${d.plan_id}: ${d.title} — ${d.rationale}`);

  const body = [
    `# 9999 Fidelity Review — ${summary.specSlug}`,
    "",
    `_Auto-generated ${dateStr} by the spec-fidelity checker (plan 0053)._`,
    "",
    "## Goal",
    "",
    `Resolve the drift flagged by the most recent fidelity check of \`${summary.specSlug}\` and decide how to proceed.`,
    "",
    "## Why Now",
    "",
    `The drift score (${summary.score}) exceeded the threshold (${summary.threshold}). The orchestrator has auto-blocked every active plan until an operator reviews this report and unblocks or reshapes the active work.`,
    "",
    "## Scope",
    "",
    "- Read the full fidelity report (see links below).",
    "- Decide for each unmet requirement: draft a new plan, defer, or accept.",
    "- Decide for each drift item: keep, roll back, or fold into a new plan.",
    '- Unblock (or discard) the plans listed under "Blocked on this review".',
    "- Delete this file once the review is resolved.",
    "",
    "## Report links",
    "",
    `- Markdown report: \`${reportMarkdownPath}\``,
    `- JSON summary:    \`${reportSummaryPath}\``,
    "",
    "## Blocked on this review",
    "",
    ...blockedLines,
    "",
    "## Unmet spec requirements",
    "",
    ...unmetLines,
    "",
    "## Drift flagged",
    "",
    ...driftLines,
    "",
    "## Out Of Scope",
    "",
    "- Implementing the remediation plans themselves — this meta-plan is a review gate, not an implementation.",
    "",
    "## Milestones",
    "",
    "1. Review the fidelity report in full.",
    "2. File or amend the plans needed to close the unmet / drift items.",
    "3. Unblock (or remove) every plan the checker auto-blocked.",
    "4. Delete this meta-plan.",
    "",
    "## Validation",
    "",
    "- `./scripts/plan-graph.sh validate` stays green after you unblock plans and remove this file.",
    "",
    "## Open Questions",
    "",
    "- Resolved by the operator during review.",
    "",
    "## Decision Log",
    "",
    `- ${dateStr}: auto-generated by the spec-fidelity checker at drift score ${summary.score}.`,
    "",
  ].join("\n");

  return frontmatter + body;
}
