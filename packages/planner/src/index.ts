// Public surface of @fork-and-go/planner. Everything downstream (CLI, tests)
// imports from here so the internal layout can move without breaking call
// sites.

export {
  runPlanner,
  type PlannerDeps,
  type PlannerRunOptions,
  type PlannerRunOutcome,
  type PlannerFailureStage,
} from "./planner.ts";

export {
  ingest,
  IngestError,
  nextPlanIdAfter,
  type PlanningContext,
  type IngestOptions,
  type PlanSummary,
  type ContextDrop,
} from "./ingest.ts";

export {
  decompose,
  type DecomposeDeps,
  type DecomposeResult,
  type DecomposeAttempt,
} from "./decompose.ts";

export {
  draftPlanBody,
  REQUIRED_SECTIONS,
  type DraftDeps,
  type DraftResult,
  type DraftAttempt,
} from "./draft.ts";

export {
  composePlanFile,
  emit,
  previewEmit,
  type EmitInput,
  type EmitOptions,
  type EmitResult,
  type EmitFailureKind,
} from "./emit.ts";

export {
  DEFAULT_MAX_NEW_PLANS,
  detectIdConflicts,
  enforceCap,
  enforceNewIdsOnly,
  enforceNoCyclesAcrossProposals,
  enforceNoDuplicateProposalIds,
  enforceNoSelfDependency,
  runProposalGuardrails,
  type GuardrailFailureKind,
  type GuardrailOptions,
  type GuardrailResult,
} from "./guardrails.ts";

export {
  planProposalSchema,
  decomposeOutputSchema,
  type PlanProposal,
  type DecomposeOutput,
  type PlannerRunResult,
} from "./schemas.ts";

export {
  addUsage,
  createInMemoryPlannerAuditSink,
  createLoggerPlannerAuditSink,
  createNoopPlannerAuditSink,
  zeroUsage,
  type PlannerAuditEvent,
  type PlannerAuditKind,
  type PlannerAuditSink,
  type PlanningCompletedEvent,
  type PlanningConflictEvent,
  type PlanningFailedEvent,
  type PlanningPlanWrittenEvent,
  type PlanningProposalsEmittedEvent,
  type PlanningStartedEvent,
  type PlanningTurnEvent,
} from "./audit.ts";

export { loadPlannerPrompts, type PlannerPrompts } from "./prompts.ts";
