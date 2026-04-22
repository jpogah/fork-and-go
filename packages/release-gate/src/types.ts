// Shared types for the release gate. The parser emits an `AcceptanceSpec`;
// the checker consumes one and produces an `AcceptanceReport`.

export interface AcceptanceCriterion {
  tag: string;
  description: string;
  testedBy: string[];
  coveredByPlans: string[];
  requiredConnections: string[];
  // Source line number (1-based) of the top-level bullet, used in parse
  // errors and report output so an operator can navigate back to the file.
  line: number;
}

export interface AcceptanceSpec {
  title: string;
  criteria: AcceptanceCriterion[];
  environmentRequirements: string[];
  filePath: string;
}

export type CriterionStatus =
  | "covered"
  | "uncovered"
  | "covered-but-test-missing"
  | "covered-but-test-failed";

export interface CriterionCheck {
  tag: string;
  description: string;
  status: CriterionStatus;
  coveringPlans: ReadonlyArray<{ id: string; title: string; status: string }>;
  testPaths: string[];
  missingTestPaths: string[];
  testRun?: TestRunResult | null;
  line: number;
}

export interface TestRunResult {
  testPath: string;
  ok: boolean;
  durationMs: number;
  output: string;
  command: string;
}

export type EnvRequirementStatus =
  | "set"
  | "missing-from-template"
  | "placeholder";

export interface EnvRequirementCheck {
  name: string;
  status: EnvRequirementStatus;
  valueKind?: "empty" | "placeholder" | "set";
}

export interface AcceptanceReport {
  generatedAt: string;
  specPath: string;
  specTitle: string;
  criteria: CriterionCheck[];
  environment: EnvRequirementCheck[];
  // Overall gate result: passes only if every criterion is `covered` (with
  // any cited tests passing when --run-tests was used) and every env var is
  // `set`. Caller translates this to an exit code.
  passed: boolean;
  ranTests: boolean;
  envTemplatePath: string;
}
