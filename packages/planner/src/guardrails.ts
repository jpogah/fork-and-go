// Guardrails for the planner. These are the safety rails that stand between
// "the LLM proposed something" and "the planner writes it to disk." Every
// check here returns a discriminated result so callers can classify failures
// cleanly — preview mode surfaces them to the operator, emit mode halts.
//
// None of these helpers touch the filesystem. Caller threads in the proposal
// set + existing plans.

import { validateGraph, type Plan } from "@fork-and-go/plan-graph";

import type { PlanProposal } from "./schemas.ts";

// The cap is a safety ceiling, not a target. The LLM prompt is instructed
// to decompose the spec by its natural complexity; this number only
// prevents runaway outputs. Set generously — most real specs produce
// between 4 and 20 plans, so 30 leaves meaningful headroom.
export const DEFAULT_MAX_NEW_PLANS = 30;

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: string; kind: GuardrailFailureKind };

export type GuardrailFailureKind =
  | "cap-exceeded"
  | "duplicate-proposal-id"
  | "id-collision"
  | "id-below-existing"
  | "self-dependency"
  | "cycle-in-proposals"
  | "graph-invalid";

export interface GuardrailOptions {
  maxNewPlans?: number;
}

export function enforceCap(
  proposals: ReadonlyArray<PlanProposal>,
  options: GuardrailOptions = {},
): GuardrailResult {
  const cap = options.maxNewPlans ?? DEFAULT_MAX_NEW_PLANS;
  if (proposals.length > cap) {
    return {
      ok: false,
      kind: "cap-exceeded",
      reason: `Planner proposed ${proposals.length} plans but the cap is ${cap}. Propose breaking the spec into phases, or re-run with --max-new-plans.`,
    };
  }
  return { ok: true };
}

export function enforceNoDuplicateProposalIds(
  proposals: ReadonlyArray<PlanProposal>,
): GuardrailResult {
  const seen = new Set<string>();
  for (const p of proposals) {
    if (seen.has(p.id)) {
      return {
        ok: false,
        kind: "duplicate-proposal-id",
        reason: `Proposal id ${p.id} appears more than once in the decompose output.`,
      };
    }
    seen.add(p.id);
  }
  return { ok: true };
}

export function enforceNewIdsOnly(
  proposals: ReadonlyArray<PlanProposal>,
  existingPlans: ReadonlyArray<Plan>,
  highestExistingId: number,
): GuardrailResult {
  const existing = new Set(existingPlans.map((p) => p.id));
  for (const proposal of proposals) {
    if (existing.has(proposal.id)) {
      return {
        ok: false,
        kind: "id-collision",
        reason: `Proposal id ${proposal.id} collides with an existing plan. New proposals must use ids greater than ${highestExistingId.toString().padStart(4, "0")}.`,
      };
    }
    const numeric = Number.parseInt(proposal.id, 10);
    if (!Number.isFinite(numeric) || numeric <= highestExistingId) {
      return {
        ok: false,
        kind: "id-below-existing",
        reason: `Proposal id ${proposal.id} must be greater than the highest existing plan id ${highestExistingId.toString().padStart(4, "0")}.`,
      };
    }
  }
  return { ok: true };
}

export function enforceNoSelfDependency(
  proposals: ReadonlyArray<PlanProposal>,
): GuardrailResult {
  for (const proposal of proposals) {
    if (proposal.depends_on.includes(proposal.id)) {
      return {
        ok: false,
        kind: "self-dependency",
        reason: `Proposal ${proposal.id} lists itself in depends_on.`,
      };
    }
  }
  return { ok: true };
}

export function enforceNoCyclesAcrossProposals(
  proposals: ReadonlyArray<PlanProposal>,
  existingPlans: ReadonlyArray<Plan>,
): GuardrailResult {
  // Build a synthetic plan list (existing + proposals) and reuse the
  // validator's cycle detector. Proposals whose ids collide with an existing
  // plan are excluded from the synthetic set — those collisions are handled
  // by `detectIdConflicts`, not the cycle check. Proposal ids are treated as
  // `active` plans for cycle purposes — the concrete status is irrelevant to
  // cycle math.
  const existingIds = new Set(existingPlans.map((p) => p.id));
  const syntheticProposals = proposals.filter((p) => !existingIds.has(p.id));
  const synthetic: Plan[] = [
    ...existingPlans,
    ...syntheticProposals.map<Plan>((p) => ({
      id: p.id,
      title: p.title,
      phase: p.phase,
      status: "active",
      dependsOn: [...p.depends_on].sort(),
      estimatedPasses: p.estimated_passes,
      acceptanceTags: [],
      location: "active",
      // Use a filename that satisfies the validator's id-filename check so
      // the synthetic plan doesn't produce a spurious mismatch issue.
      filePath: `SYNTHETIC/${p.id}-${p.slug}.md`,
      body: "",
      raw: {
        id: p.id,
        title: p.title,
        phase: p.phase,
        status: "active",
        depends_on: [...p.depends_on],
        estimated_passes: p.estimated_passes,
        acceptance_tags: [],
      },
    })),
  ];
  const result = validateGraph(synthetic);
  if (result.ok) return { ok: true };

  // We care about cycle, missing-dependency, and self-dependency here.
  // `duplicate-id`, `id-filename-mismatch`, and `status-location-mismatch`
  // reflect pre-existing state of the repo that the planner is not
  // introducing and that other guardrails (or the caller) already handle.
  const cycle = result.issues.find((i) => i.kind === "cycle");
  if (cycle) {
    return {
      ok: false,
      kind: "cycle-in-proposals",
      reason: `Proposals introduce a dependency cycle: ${cycle.kind === "cycle" ? cycle.path.join(" -> ") : ""}`,
    };
  }
  const relevant = result.issues.find(
    (i) => i.kind === "missing-dependency" || i.kind === "self-dependency",
  );
  if (!relevant) return { ok: true };
  if (relevant.kind === "missing-dependency") {
    return {
      ok: false,
      kind: "graph-invalid",
      reason: `Plan ${relevant.id} depends on unknown plan ${relevant.missing}`,
    };
  }
  return {
    ok: false,
    kind: "graph-invalid",
    reason: `Plan ${relevant.id} depends on itself`,
  };
}

export interface ConflictCheck {
  existingActivePlanIds: ReadonlyArray<string>;
  existingCompletedPlanIds: ReadonlyArray<string>;
  proposedMatches: ReadonlyArray<{
    proposedId: string;
    existingId: string;
    reason: string;
  }>;
}

// `detectIdConflicts` looks at whether any proposal id is already present in
// the repo. Returns a list of conflicts (both active and completed) so the
// caller can skip / conflict-flag appropriately. This is separate from
// `enforceNewIdsOnly` because the planner's idempotency rules allow "soft
// collisions" when re-running on the same spec — the decomposer deliberately
// includes an existing id if the plan already exists.
export function detectIdConflicts(
  proposals: ReadonlyArray<PlanProposal>,
  existingPlans: ReadonlyArray<Plan>,
): {
  activeConflicts: Array<{ id: string; existingTitle: string }>;
  completedConflicts: Array<{ id: string; existingTitle: string }>;
  fresh: PlanProposal[];
} {
  const byId = new Map(existingPlans.map((p) => [p.id, p]));
  const activeConflicts: Array<{ id: string; existingTitle: string }> = [];
  const completedConflicts: Array<{ id: string; existingTitle: string }> = [];
  const fresh: PlanProposal[] = [];
  for (const proposal of proposals) {
    const existing = byId.get(proposal.id);
    if (!existing) {
      fresh.push(proposal);
      continue;
    }
    if (existing.status === "completed") {
      completedConflicts.push({
        id: proposal.id,
        existingTitle: existing.title,
      });
    } else {
      activeConflicts.push({ id: proposal.id, existingTitle: existing.title });
    }
  }
  return { activeConflicts, completedConflicts, fresh };
}

// `runProposalGuardrails` runs every pre-write check and returns the first failure.
// Order: duplicate proposal ids -> self-dependency -> cap -> cycle-in-graph.
// The "new ids only" check is *not* applied here because idempotency allows
// re-proposing existing ids (handled by `detectIdConflicts`). It's up to the
// caller to apply that check to the *fresh* subset after conflict resolution.
export function runProposalGuardrails(
  proposals: ReadonlyArray<PlanProposal>,
  existingPlans: ReadonlyArray<Plan>,
  options: GuardrailOptions = {},
): GuardrailResult {
  const dup = enforceNoDuplicateProposalIds(proposals);
  if (!dup.ok) return dup;
  const self = enforceNoSelfDependency(proposals);
  if (!self.ok) return self;
  const cap = enforceCap(proposals, options);
  if (!cap.ok) return cap;
  const cycles = enforceNoCyclesAcrossProposals(proposals, existingPlans);
  if (!cycles.ok) return cycles;
  return { ok: true };
}
