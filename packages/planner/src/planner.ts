// Top-level planner orchestration. Wires ingest -> decompose -> (guardrails)
// -> (idempotency filter) -> draft (per proposal) -> emit. Audit events are
// emitted at every major transition so an operator or downstream tool can
// reconstruct the run.
//
// The orchestrator is deterministic except for the two LLM calls (decompose
// and draft); every other step is pure. Tests inject a stub model client.

import { writeFileSync } from "node:fs";

import { MODEL_CLIENT_DEFAULT_MODEL, MODEL_CLIENT_REPAIR_MODEL } from "@fork-and-go/model-client";
import type { ModelClient, ModelUsage } from "@fork-and-go/model-client";
import {
  generatePlansMarkdown,
  loadPlans,
  type Plan,
} from "@fork-and-go/plan-graph";

import {
  addUsage,
  createNoopPlannerAuditSink,
  zeroUsage,
  type PlannerAuditSink,
} from "./audit.ts";
import { decompose } from "./decompose.ts";
import { draftPlanBody } from "./draft.ts";
import { emit, previewEmit, type EmitInput } from "./emit.ts";
import {
  DEFAULT_MAX_NEW_PLANS,
  detectIdConflicts,
  enforceNewIdsOnly,
  runProposalGuardrails,
} from "./guardrails.ts";
import { ingest, type PlanningContext } from "./ingest.ts";
import { loadPlannerPrompts, type PlannerPrompts } from "./prompts.ts";
import type { PlanProposal, PlannerRunResult } from "./schemas.ts";

export interface PlannerDeps {
  modelClient: ModelClient;
  auditSink?: PlannerAuditSink;
  clock?: () => Date;
  prompts?: PlannerPrompts;
  defaultModel?: string;
  repairModel?: string;
  maxRepairAttempts?: number;
  // Generates run ids; the CLI uses a wall-clock + process id; tests pass a
  // deterministic generator so audit snapshots are comparable.
  generateRunId?: () => string;
}

export interface PlannerRunOptions {
  specPath: string;
  activeDir: string;
  completedDir: string;
  contextDir?: string;
  repoRoot: string;
  mode: "preview" | "emit";
  maxNewPlans?: number;
  // When set, the planner regenerates PLANS.md at this path after a
  // successful emit (see the Technical Thesis in plan 0049). The CLI wires
  // this to `<repoRoot>/docs/PLANS.md`; test runs leave it undefined to
  // avoid needing a `docs/` tree in the workspace.
  plansMdPath?: string;
  // Plan 0054: optional paired acceptance tags. When supplied, the
  // decompose prompt lists them so the LLM can claim the right tags on
  // each proposal it emits. Callers (CLI, tests) resolve an acceptance
  // file and pass the parsed list in — the planner intentionally does not
  // depend on `@fork-and-go/release-gate` to keep the package boundary clean.
  // Absence of this option leaves `acceptance_tags: []` on every emitted
  // plan — identical to behaviour before 0054.
  acceptanceTags?: ReadonlyArray<{ tag: string; description: string }>;
}

import type { ContextParseWarning } from "@fork-and-go/context-ingest";

export type PlannerRunOutcome =
  | {
      ok: true;
      result: PlannerRunResult;
      contextWarnings: ReadonlyArray<ContextParseWarning>;
    }
  | {
      ok: false;
      reason: string;
      stage: PlannerFailureStage;
      contextWarnings: ReadonlyArray<ContextParseWarning>;
    };

export type PlannerFailureStage =
  | "ingest"
  | "decompose"
  | "guardrail"
  | "draft"
  | "emit";

export async function runPlanner(
  options: PlannerRunOptions,
  deps: PlannerDeps,
): Promise<PlannerRunOutcome> {
  const auditSink = deps.auditSink ?? createNoopPlannerAuditSink();
  const clock = deps.clock ?? (() => new Date());
  const prompts = deps.prompts ?? loadPlannerPrompts();
  const defaultModel = deps.defaultModel ?? MODEL_CLIENT_DEFAULT_MODEL;
  const repairModel = deps.repairModel ?? MODEL_CLIENT_REPAIR_MODEL;
  const runId = deps.generateRunId ? deps.generateRunId() : defaultRunId();
  const maxNewPlans = options.maxNewPlans ?? DEFAULT_MAX_NEW_PLANS;

  const baseEvent = {
    runId,
    specPath: options.specPath,
  };

  await auditSink.record({
    ...baseEvent,
    timestamp: clock().toISOString(),
    kind: "planning.started",
    payload: { mode: options.mode, maxNewPlans },
  });

  let context: PlanningContext;
  try {
    context = ingest({
      specPath: options.specPath,
      activeDir: options.activeDir,
      completedDir: options.completedDir,
      ...(options.contextDir !== undefined
        ? { contextDir: options.contextDir }
        : {}),
      ...(options.acceptanceTags !== undefined
        ? { acceptanceTags: options.acceptanceTags }
        : {}),
      repoRoot: options.repoRoot,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: { stage: "ingest", reason },
    });
    return { ok: false, reason, stage: "ingest", contextWarnings: [] };
  }

  let totalUsage: ModelUsage = zeroUsage();

  const decomposeResult = await decompose(context, maxNewPlans, {
    modelClient: deps.modelClient,
    systemPrompt: prompts.decompose,
    defaultModel,
    repairModel,
    ...(deps.maxRepairAttempts !== undefined
      ? { maxRepairAttempts: deps.maxRepairAttempts }
      : {}),
  });
  for (const attempt of decomposeResult.attempts) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.turn",
      payload: {
        phase: "decompose",
        model: attempt.model,
        usage: attempt.usage,
        attempts: decomposeResult.attempts.length,
        repaired: decomposeResult.attempts.length > 1,
        ok: attempt.ok,
        ...(attempt.error !== undefined ? { error: attempt.error } : {}),
      },
    });
  }
  totalUsage = addUsage(totalUsage, decomposeResult.totalUsage);

  if (!decomposeResult.ok) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: { stage: "decompose", reason: decomposeResult.reason },
    });
    return {
      ok: false,
      reason: decomposeResult.reason,
      stage: "decompose",
      contextWarnings: context.contextWarnings,
    };
  }

  const existingPlans = await loadExistingPlans(options);

  // Pre-check: duplicate ids / self-dep / cap / cycles in proposals.
  const proposalGuardrail = runProposalGuardrails(
    decomposeResult.proposals,
    existingPlans,
    { maxNewPlans },
  );
  if (!proposalGuardrail.ok) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: { stage: "guardrail", reason: proposalGuardrail.reason },
    });
    return {
      ok: false,
      reason: proposalGuardrail.reason,
      stage: "guardrail",
      contextWarnings: context.contextWarnings,
    };
  }

  // Idempotency: split proposals by whether the id is new, matches a
  // completed plan (skip), or matches an active plan (conflict).
  const conflictSplit = detectIdConflicts(
    decomposeResult.proposals,
    existingPlans,
  );

  for (const conflict of conflictSplit.activeConflicts) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.conflict",
      payload: {
        id: conflict.id,
        reason: `Proposal id ${conflict.id} matches an active plan '${conflict.existingTitle}'. Resolve manually before re-running.`,
      },
    });
  }

  const skipped: PlannerRunResult["skipped"] = [
    ...conflictSplit.completedConflicts.map((c) => ({
      id: c.id,
      reason: "completed" as const,
    })),
  ];
  const conflicts: PlannerRunResult["conflicts"] =
    conflictSplit.activeConflicts.map((c) => ({
      id: c.id,
      reason: `matches active plan '${c.existingTitle}'`,
    }));

  if (conflictSplit.activeConflicts.length > 0) {
    const summary = conflictSplit.activeConflicts
      .map((c) => `${c.id} (${c.existingTitle})`)
      .join(", ");
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: {
        stage: "guardrail",
        reason: `Refusing to emit — proposal ids conflict with active plans: ${summary}`,
      },
    });
    return {
      ok: false,
      reason: `Proposal ids conflict with active plans: ${summary}`,
      stage: "guardrail",
      contextWarnings: context.contextWarnings,
    };
  }

  const fresh = conflictSplit.fresh;

  // Any truly new id must land above the highest existing id.
  const freshness = enforceNewIdsOnly(
    fresh,
    existingPlans,
    context.highestPlanIdNumeric,
  );
  if (!freshness.ok) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: { stage: "guardrail", reason: freshness.reason },
    });
    return {
      ok: false,
      reason: freshness.reason,
      stage: "guardrail",
      contextWarnings: context.contextWarnings,
    };
  }

  await auditSink.record({
    ...baseEvent,
    timestamp: clock().toISOString(),
    kind: "planning.proposals_emitted",
    payload: {
      proposalIds: fresh.map((p) => p.id),
      mode: options.mode,
    },
  });

  // Preview mode stops before drafting.
  if (options.mode === "preview") {
    const preview = previewEmit(
      fresh.map<EmitInput>((proposal) => ({
        proposal,
        body: placeholderBodyForPreview(proposal),
      })),
      { activeDir: options.activeDir, existingPlans },
    );
    if (!preview.ok) {
      await auditSink.record({
        ...baseEvent,
        timestamp: clock().toISOString(),
        kind: "planning.failed",
        payload: { stage: "emit", reason: preview.reason },
      });
      return {
        ok: false,
        reason: preview.reason,
        stage: "emit",
        contextWarnings: context.contextWarnings,
      };
    }
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.completed",
      payload: {
        emittedCount: 0,
        skippedCount: skipped.length,
        conflictCount: conflicts.length,
        mode: "preview",
        totalUsage,
      },
    });
    return {
      ok: true,
      result: {
        proposals: fresh,
        emitted: [],
        skipped,
        conflicts,
        mode: "preview",
      },
      contextWarnings: context.contextWarnings,
    };
  }

  // Full emit: draft each proposal, then emit atomically.
  const drafts: EmitInput[] = [];
  for (const proposal of fresh) {
    const draftResult = await draftPlanBody(proposal, {
      modelClient: deps.modelClient,
      systemPrompt: prompts.draft,
      defaultModel,
      repairModel,
      ...(deps.maxRepairAttempts !== undefined
        ? { maxRepairAttempts: deps.maxRepairAttempts }
        : {}),
    });
    for (const attempt of draftResult.attempts) {
      await auditSink.record({
        ...baseEvent,
        timestamp: clock().toISOString(),
        kind: "planning.turn",
        payload: {
          phase: "draft",
          proposalId: proposal.id,
          model: attempt.model,
          usage: attempt.usage,
          attempts: draftResult.attempts.length,
          repaired: draftResult.attempts.length > 1,
          ok: attempt.ok,
          ...(attempt.error !== undefined ? { error: attempt.error } : {}),
        },
      });
    }
    totalUsage = addUsage(totalUsage, draftResult.totalUsage);
    if (!draftResult.ok) {
      await auditSink.record({
        ...baseEvent,
        timestamp: clock().toISOString(),
        kind: "planning.failed",
        payload: { stage: "draft", reason: draftResult.reason },
      });
      return {
        ok: false,
        reason: draftResult.reason,
        stage: "draft",
        contextWarnings: context.contextWarnings,
      };
    }
    drafts.push({ proposal, body: draftResult.body });
  }

  const emitResult = emit(drafts, {
    activeDir: options.activeDir,
    existingPlans,
  });
  if (!emitResult.ok) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.failed",
      payload: { stage: "emit", reason: emitResult.reason },
    });
    return {
      ok: false,
      reason: emitResult.reason,
      stage: "emit",
      contextWarnings: context.contextWarnings,
    };
  }

  for (const written of emitResult.written) {
    await auditSink.record({
      ...baseEvent,
      timestamp: clock().toISOString(),
      kind: "planning.plan_written",
      payload: written,
    });
  }

  // Regenerate PLANS.md from the post-emit state so the index stays in sync
  // with the plans that just landed. Skipped when no `plansMdPath` is given
  // (test workspaces typically have no docs/ tree). A failure here is
  // surfaced as a `plansMdRegenerationError` on the `planning.completed`
  // event rather than a `planning.failed` event — the emit itself succeeded
  // and `planning.failed` is terminal for downstream audit consumers. The
  // plan files on disk are the source of truth, and
  // `./scripts/plan-graph.sh generate-md` can be re-run by hand.
  let plansMdRegenerationError: string | undefined;
  if (options.plansMdPath !== undefined) {
    try {
      const postEmitPlans = await loadExistingPlans(options);
      const markdown = generatePlansMarkdown(
        [...postEmitPlans],
        options.repoRoot,
      );
      writeFileSync(options.plansMdPath, markdown, "utf8");
    } catch (err) {
      plansMdRegenerationError =
        err instanceof Error ? err.message : String(err);
    }
  }

  await auditSink.record({
    ...baseEvent,
    timestamp: clock().toISOString(),
    kind: "planning.completed",
    payload: {
      emittedCount: emitResult.written.length,
      skippedCount: skipped.length,
      conflictCount: conflicts.length,
      mode: "emit",
      totalUsage,
      ...(plansMdRegenerationError !== undefined
        ? { plansMdRegenerationError }
        : {}),
    },
  });

  return {
    ok: true,
    result: {
      proposals: fresh,
      emitted: emitResult.written,
      skipped,
      conflicts,
      mode: "emit",
    },
    contextWarnings: context.contextWarnings,
  };
}

async function loadExistingPlans(
  options: PlannerRunOptions,
): Promise<ReadonlyArray<Plan>> {
  return loadPlans({
    activeDir: options.activeDir,
    completedDir: options.completedDir,
  });
}

function placeholderBodyForPreview(proposal: PlanProposal): string {
  // Preview mode uses a minimal but structurally valid body so the graph
  // validator can run against a realistic synthetic plan. The body is
  // never written to disk in preview mode — only used for validation.
  return [
    `# ${proposal.id} ${proposal.title}`,
    "",
    "## Goal",
    proposal.summary,
    "",
    "## Why Now",
    "(preview)",
    "",
    "## Scope",
    ...proposal.scope_bullets.map((b) => `- ${b}`),
    "",
    "## Out Of Scope",
    "- (preview)",
    "",
    "## Milestones",
    "1. (preview)",
    "",
    "## Validation",
    "- (preview)",
    "",
    "## Open Questions",
    "- (preview)",
    "",
    "## Decision Log",
    "- (preview)",
    "",
  ].join("\n");
}

function defaultRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `planner-${ts}-${suffix}`;
}
