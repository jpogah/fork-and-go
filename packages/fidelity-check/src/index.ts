// Public surface of @fork-and-go/fidelity-check. Everything downstream (CLI,
// orchestrator hook, tests) imports from here.

export {
  buildContext,
  FidelityContextError,
  type BuildContextOptions,
  type FidelityContext,
  type PlanSummary,
} from "./context-builder.ts";

export {
  audit,
  type AuditDeps,
  type AuditResult,
  type AuditAttempt,
} from "./audit.ts";

export {
  auditOutputSchema,
  requirementItemSchema,
  driftItemSchema,
  riskFindingSchema,
  COVERAGE_STATUSES,
  RISK_LEVELS,
  type AuditOutput,
  type RequirementItem,
  type DriftItem,
  type RiskFinding,
  type CoverageStatus,
  type RiskLevel,
} from "./schemas.ts";

export {
  computeDrift,
  exceedsThreshold,
  DEFAULT_THRESHOLD,
  type DriftComputation,
} from "./score.ts";

export {
  writeReport,
  type WriteReportOptions,
  type WriteReportResult,
  type FidelitySummary,
} from "./report-writer.ts";

export {
  suspendForFidelityReview,
  META_PLAN_FILENAME,
  META_PLAN_ID,
  type SuspendOptions,
  type SuspendResult,
} from "./suspend.ts";

export {
  runFidelityCheck,
  type RunFidelityOptions,
  type RunFidelityDeps,
  type RunFidelityOutcome,
} from "./runner.ts";

export { loadFidelityPrompts, type FidelityPrompts } from "./prompts.ts";
