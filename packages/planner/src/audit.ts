// Audit events emitted by the planner. Mirrors the harness sink pattern:
// callers inject their preferred sink (no-op, in-memory for tests, logger,
// Postgres-backed once the audit store wires planner events). The event
// payloads are intentionally small and schemaless beyond what an operator
// needs to reconstruct a run — tokens, model, cost, proposal ids, failures.

import type { ModelUsage } from "@fork-and-go/model-client";

export type PlannerAuditKind =
  | "planning.started"
  | "planning.turn"
  | "planning.proposals_emitted"
  | "planning.plan_written"
  | "planning.conflict"
  | "planning.failed"
  | "planning.completed";

type BaseEvent = {
  runId: string;
  specPath: string;
  timestamp: string;
};

export type PlanningStartedEvent = BaseEvent & {
  kind: "planning.started";
  payload: {
    mode: "preview" | "emit";
    maxNewPlans: number;
  };
};

export type PlanningTurnEvent = BaseEvent & {
  kind: "planning.turn";
  payload: {
    phase: "decompose" | "draft";
    proposalId?: string;
    model: string;
    usage: ModelUsage;
    attempts: number;
    repaired: boolean;
    ok: boolean;
    error?: string;
  };
};

export type PlanningProposalsEmittedEvent = BaseEvent & {
  kind: "planning.proposals_emitted";
  payload: {
    proposalIds: ReadonlyArray<string>;
    mode: "preview" | "emit";
  };
};

export type PlanningPlanWrittenEvent = BaseEvent & {
  kind: "planning.plan_written";
  payload: {
    id: string;
    filePath: string;
  };
};

export type PlanningConflictEvent = BaseEvent & {
  kind: "planning.conflict";
  payload: {
    id: string;
    reason: string;
  };
};

export type PlanningFailedEvent = BaseEvent & {
  kind: "planning.failed";
  payload: {
    stage: "ingest" | "decompose" | "draft" | "emit" | "guardrail";
    reason: string;
  };
};

export type PlanningCompletedEvent = BaseEvent & {
  kind: "planning.completed";
  payload: {
    emittedCount: number;
    skippedCount: number;
    conflictCount: number;
    mode: "preview" | "emit";
    totalUsage: ModelUsage;
    // Set when the emit itself succeeded but the post-emit PLANS.md
    // regeneration failed. Downstream consumers should surface this as a
    // warning; the run still succeeded (plan files on disk are the source
    // of truth) but the operator needs to re-run
    // `./scripts/plan-graph.sh generate-md` by hand.
    plansMdRegenerationError?: string;
  };
};

export type PlannerAuditEvent =
  | PlanningStartedEvent
  | PlanningTurnEvent
  | PlanningProposalsEmittedEvent
  | PlanningPlanWrittenEvent
  | PlanningConflictEvent
  | PlanningFailedEvent
  | PlanningCompletedEvent;

export interface PlannerAuditSink {
  record(event: PlannerAuditEvent): Promise<void> | void;
}

export function createNoopPlannerAuditSink(): PlannerAuditSink {
  return {
    record() {
      // Intentional: default sink when no audit backend is wired.
    },
  };
}

export function createInMemoryPlannerAuditSink(): PlannerAuditSink & {
  events: PlannerAuditEvent[];
} {
  const events: PlannerAuditEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
  };
}

export function createLoggerPlannerAuditSink(
  options: { logger?: (line: string) => void } = {},
): PlannerAuditSink {
  const logger = options.logger ?? ((line: string) => console.log(line));
  return {
    record(event) {
      logger(JSON.stringify({ source: "fork-and-go.planner", ...event }));
    },
  };
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costCents: Math.round((a.costCents + b.costCents) * 100) / 100,
  };
}

export function zeroUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, costCents: 0 };
}
