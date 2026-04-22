// Top-level runner: orchestrates parse -> load plans -> check -> render.
// The CLI wraps this; the orchestrator post-merge hook calls `runReleaseGate`
// directly with `writeReport: false` so it can inspect the outcome without
// churning disk when nothing changed.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadPlans, type Plan } from "@fork-and-go/plan-graph";

import { checkAcceptance } from "./checker.ts";
import {
  parseAcceptanceFile,
  AcceptanceParseError,
  type AcceptanceSpec,
} from "./parser.ts";
import {
  renderReleaseReport,
  writeReleaseReport,
  type WriteReportResult,
} from "./report.ts";
import type { AcceptanceReport, TestRunResult } from "./types.ts";

export interface RunReleaseGateOptions {
  specPath: string;
  activeDir: string;
  completedDir: string;
  envTemplatePath: string;
  reportsDir: string;
  repoRoot: string;
  now?: () => Date;
  runTests?: boolean;
  writeReport?: boolean;
  // Optional override for the test runner. Defaults to vitest run <path>
  // so criteria that cite a test file can be exercised as part of the gate.
  runTest?: (testPath: string) => TestRunResult | Promise<TestRunResult>;
}

export type ReleaseGateOutcome =
  | {
      ok: true;
      report: AcceptanceReport;
      writeResult: WriteReportResult | null;
      renderedMarkdown: string;
    }
  | {
      ok: false;
      stage: "parse" | "load-plans" | "env-template";
      reason: string;
    };

export async function runReleaseGate(
  options: RunReleaseGateOptions,
): Promise<ReleaseGateOutcome> {
  let spec: AcceptanceSpec;
  try {
    spec = parseAcceptanceFile(options.specPath);
  } catch (err) {
    if (err instanceof AcceptanceParseError) {
      return { ok: false, stage: "parse", reason: err.message };
    }
    return {
      ok: false,
      stage: "parse",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let plans: ReadonlyArray<Plan>;
  try {
    plans = loadPlans({
      activeDir: options.activeDir,
      completedDir: options.completedDir,
    });
  } catch (err) {
    return {
      ok: false,
      stage: "load-plans",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let envTemplateContent: string;
  try {
    if (!existsSync(options.envTemplatePath)) {
      return {
        ok: false,
        stage: "env-template",
        reason: `env template not found at ${options.envTemplatePath}`,
      };
    }
    envTemplateContent = readFileSync(options.envTemplatePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      stage: "env-template",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const runTest =
    options.runTests !== true
      ? undefined
      : (options.runTest ?? defaultVitestRunner(options.repoRoot));
  const check = await checkAcceptance({
    spec,
    plans,
    envTemplateContent,
    repoRoot: options.repoRoot,
    ...(runTest ? { runTest } : {}),
  });

  const now = (options.now ?? (() => new Date()))();
  const report: AcceptanceReport = {
    generatedAt: now.toISOString(),
    specPath: path.relative(options.repoRoot, options.specPath),
    specTitle: spec.title,
    criteria: check.criteria,
    environment: check.environment,
    passed: check.passed,
    ranTests: Boolean(options.runTests),
    envTemplatePath: path.relative(options.repoRoot, options.envTemplatePath),
  };

  const rendered = renderReleaseReport(report);
  let writeResult: WriteReportResult | null = null;
  if (options.writeReport !== false) {
    writeResult = writeReleaseReport(report, {
      reportsDir: options.reportsDir,
      specSlug: specSlug(options.specPath),
      now,
    });
  }

  return { ok: true, report, writeResult, renderedMarkdown: rendered };
}

// Orchestrator-facing convenience: detects the `release_candidate_ready`
// signal by file, so the daemon can skip re-running the gate on every tick.
export function readReleaseReadyFile(stateDir: string): {
  exists: boolean;
  payload?: { specPath: string | null; at: string; reportPath: string | null };
} {
  const file = path.join(stateDir, "RELEASE_READY");
  if (!existsSync(file)) return { exists: false };
  try {
    const text = readFileSync(file, "utf8");
    return { exists: true, payload: JSON.parse(text) };
  } catch {
    // Malformed or truncated — treat as "exists but opaque." The daemon
    // will not re-write. Operator can delete to force a re-check.
    return { exists: true };
  }
}

function specSlug(specPath: string): string {
  const base = path.basename(specPath, path.extname(specPath));
  // Strip the conventional `.acceptance` suffix so reports read as
  // `<spec-slug>.md`, matching the fidelity checker's convention.
  return base.replace(/\.acceptance$/u, "").toLowerCase();
}

function defaultVitestRunner(
  repoRoot: string,
): (testPath: string) => TestRunResult {
  return (testPath) => {
    const started = Date.now();
    const result = spawnSync(
      "npx",
      ["--no-install", "vitest", "run", testPath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
      },
    );
    const durationMs = Date.now() - started;
    const stdout = (result.stdout ?? "").toString();
    const stderr = (result.stderr ?? "").toString();
    return {
      testPath,
      ok: result.status === 0,
      durationMs,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      command: `npx --no-install vitest run ${testPath}`,
    };
  };
}
