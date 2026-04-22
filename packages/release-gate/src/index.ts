// Public surface of @fork-and-go/release-gate. CLI + orchestrator hook import
// from here so the internals can move without touching call sites.

export {
  parseAcceptanceContent,
  parseAcceptanceFile,
  AcceptanceParseError,
} from "./parser.ts";

export {
  checkAcceptance,
  parseEnvTemplate,
  type CheckInputs,
  type CheckOutputs,
} from "./checker.ts";

export {
  renderReleaseReport,
  writeReleaseReport,
  type WriteReportOptions,
  type WriteReportResult,
} from "./report.ts";

export {
  runReleaseGate,
  readReleaseReadyFile,
  type ReleaseGateOutcome,
  type RunReleaseGateOptions,
} from "./runner.ts";

export type {
  AcceptanceCriterion,
  AcceptanceReport,
  AcceptanceSpec,
  CriterionCheck,
  CriterionStatus,
  EnvRequirementCheck,
  EnvRequirementStatus,
  TestRunResult,
} from "./types.ts";
