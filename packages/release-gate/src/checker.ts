// Checker: takes an `AcceptanceSpec`, a plan set, and the env template
// content, and produces a list of per-criterion + per-env checks. No disk
// writes. Coverage rule: a criterion is `covered` when at least one
// `completed` plan has the criterion's tag in its `acceptance_tags`
// frontmatter. Test existence is checked against the repo root; when
// `runTests` is supplied, each cited test is invoked through the caller-
// provided runner.

import { existsSync } from "node:fs";
import path from "node:path";

import type { Plan } from "@fork-and-go/plan-graph";

import type {
  AcceptanceSpec,
  CriterionCheck,
  CriterionStatus,
  EnvRequirementCheck,
  EnvRequirementStatus,
  TestRunResult,
} from "./types.ts";

export interface CheckInputs {
  spec: AcceptanceSpec;
  plans: ReadonlyArray<Plan>;
  envTemplateContent: string;
  repoRoot: string;
  runTest?: (testPath: string) => TestRunResult | Promise<TestRunResult>;
}

export interface CheckOutputs {
  criteria: CriterionCheck[];
  environment: EnvRequirementCheck[];
  passed: boolean;
}

export async function checkAcceptance(
  inputs: CheckInputs,
): Promise<CheckOutputs> {
  const coverageIndex = buildCoverageIndex(inputs.plans);
  const envValues = parseEnvTemplate(inputs.envTemplateContent);

  const criteria: CriterionCheck[] = [];
  for (const criterion of inputs.spec.criteria) {
    const covering = coverageIndex.get(criterion.tag) ?? [];
    const coveringPlans = covering.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
    }));
    const completedCovering = covering.filter((p) => p.status === "completed");
    const testPaths = criterion.testedBy;
    const missingTestPaths = testPaths.filter(
      (t) => !existsSync(path.resolve(inputs.repoRoot, t)),
    );

    let status: CriterionStatus;
    let testRun: TestRunResult | null = null;
    if (completedCovering.length === 0) {
      status = "uncovered";
    } else if (missingTestPaths.length > 0) {
      status = "covered-but-test-missing";
    } else if (inputs.runTest && testPaths.length > 0) {
      // Run every cited test; fail the criterion on the first non-zero run
      // so the operator sees exactly which test fell over.
      let failed = false;
      for (const t of testPaths) {
        const run = await inputs.runTest(t);
        if (!run.ok) {
          testRun = run;
          failed = true;
          break;
        }
        testRun = run;
      }
      status = failed ? "covered-but-test-failed" : "covered";
    } else {
      status = "covered";
    }

    criteria.push({
      tag: criterion.tag,
      description: criterion.description,
      status,
      coveringPlans,
      testPaths,
      missingTestPaths,
      testRun,
      line: criterion.line,
    });
  }

  const environment: EnvRequirementCheck[] =
    inputs.spec.environmentRequirements.map((name) => {
      const entry = envValues.get(name);
      const status: EnvRequirementStatus = evaluateEnvStatus(entry);
      const result: EnvRequirementCheck = { name, status };
      if (entry) result.valueKind = entry.kind;
      return result;
    });

  const allCriteriaOk = criteria.every((c) => c.status === "covered");
  const allEnvOk = environment.every((e) => e.status === "set");
  const passed = allCriteriaOk && allEnvOk;

  return { criteria, environment, passed };
}

function buildCoverageIndex(plans: ReadonlyArray<Plan>): Map<string, Plan[]> {
  const index = new Map<string, Plan[]>();
  for (const plan of plans) {
    for (const tag of plan.acceptanceTags) {
      const list = index.get(tag) ?? [];
      list.push(plan);
      index.set(tag, list);
    }
  }
  return index;
}

interface EnvEntry {
  kind: "empty" | "placeholder" | "set";
  raw: string;
}

const PLACEHOLDER_VALUES = new Set([
  "changeme",
  "replace-me",
  "replace_me",
  "your-value-here",
  "your-key-here",
  "todo",
  "xxx",
  "xxxx",
  "placeholder",
  "tbd",
]);

export function parseEnvTemplate(content: string): Map<string, EnvEntry> {
  const values = new Map<string, EnvEntry>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) continue;
    const value = line.slice(eq + 1).trim();
    const unquoted = unquote(value);
    values.set(key, { kind: classifyEnvValue(unquoted), raw: unquoted });
  }
  return values;
}

function classifyEnvValue(value: string): "empty" | "placeholder" | "set" {
  if (!value) return "empty";
  const lower = value.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lower)) return "placeholder";
  // `http://localhost:3000/...`, connection strings, and concrete defaults
  // are all "set" — the template carries them so dev works out of the box.
  return "set";
}

function evaluateEnvStatus(entry: EnvEntry | undefined): EnvRequirementStatus {
  if (!entry) return "missing-from-template";
  if (entry.kind === "set") return "set";
  if (entry.kind === "placeholder") return "placeholder";
  // Empty-value lines in `.env.example` are intentional (they document that
  // the operator must supply their own). For release-readiness we treat
  // this as "documented but not set," which is a gate fail — the release
  // template must carry working defaults (Postgres URL, redirect URIs) or
  // the env var must be marked for operator-supply elsewhere. Tagging the
  // status `placeholder` keeps the report's language uniform with the
  // actual literal-placeholder case; reports distinguish via `valueKind`.
  return "placeholder";
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
