export { PLAN_STATUSES, planFrontmatterSchema } from "./schema.ts";
export type { PlanFrontmatter, PlanStatus } from "./schema.ts";
export {
  loadPlans,
  loadPlanFile,
  splitFrontmatter,
  fileIdFromFilename,
  PlanParseError,
} from "./loader.ts";
export type { LoadPlansOptions } from "./loader.ts";
export {
  computeBlocks,
  nextEligiblePlans,
  planIndex,
  planStatus,
  topologicalOrder,
  unmetDependencies,
} from "./resolver.ts";
export { formatIssue, validateGraph } from "./validator.ts";
export type {
  GraphIssue,
  Plan,
  PlanLocation,
  PlanStatusReport,
  ValidationResult,
} from "./types.ts";
export { buildSnapshot, toDot, toMermaid } from "./graph.ts";
export type { GraphSnapshot } from "./graph.ts";
export { generatePlansMarkdown } from "./plans-md.ts";
export { setPlanStatus } from "./status-writer.ts";
export type { SetPlanStatusResult } from "./status-writer.ts";
