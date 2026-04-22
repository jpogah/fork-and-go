// Markdown report writer for the release gate. One report per invocation,
// written under `.orchestrator/release-reports/YYYY-MM-DD-<slug>.md`. The
// caller decides when to write; pure rendering stays in this module so the
// CLI can also print to stdout for `--dry-run` without touching disk.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AcceptanceReport } from "./types.ts";

export interface WriteReportOptions {
  reportsDir: string;
  specSlug: string;
  now: Date;
}

export interface WriteReportResult {
  markdownPath: string;
}

export function writeReleaseReport(
  report: AcceptanceReport,
  options: WriteReportOptions,
): WriteReportResult {
  mkdirSync(options.reportsDir, { recursive: true });
  const dateStr = options.now.toISOString().slice(0, 10);
  const markdownPath = path.join(
    options.reportsDir,
    `${dateStr}-${options.specSlug}.md`,
  );
  writeFileSync(markdownPath, renderReleaseReport(report), "utf8");
  return { markdownPath };
}

export function renderReleaseReport(report: AcceptanceReport): string {
  const icon = report.passed ? "✓ READY" : "✗ NOT READY";
  const totals = {
    total: report.criteria.length,
    covered: report.criteria.filter((c) => c.status === "covered").length,
    uncovered: report.criteria.filter((c) => c.status === "uncovered").length,
    testMissing: report.criteria.filter(
      (c) => c.status === "covered-but-test-missing",
    ).length,
    testFailed: report.criteria.filter(
      (c) => c.status === "covered-but-test-failed",
    ).length,
  };
  const envTotals = {
    total: report.environment.length,
    set: report.environment.filter((e) => e.status === "set").length,
    missing: report.environment.filter(
      (e) => e.status === "missing-from-template",
    ).length,
    placeholder: report.environment.filter((e) => e.status === "placeholder")
      .length,
  };

  const lines: string[] = [];
  lines.push(
    `# Release Readiness — ${report.generatedAt.slice(0, 10)} — ${report.specTitle || basename(report.specPath)}`,
  );
  lines.push("");
  lines.push(`## Result: ${icon}`);
  lines.push("");
  lines.push(
    `- Criteria: ${totals.covered}/${totals.total} covered (${totals.uncovered} uncovered, ${totals.testMissing} test-missing, ${totals.testFailed} test-failed)`,
  );
  lines.push(
    `- Environment: ${envTotals.set}/${envTotals.total} set (${envTotals.missing} missing, ${envTotals.placeholder} placeholder)`,
  );
  lines.push(`- Spec: \`${report.specPath}\``);
  lines.push(`- Env template: \`${report.envTemplatePath}\``);
  if (report.ranTests) {
    lines.push("- Tests executed: yes (--run-tests)");
  } else {
    lines.push("- Tests executed: no (coverage-only check)");
  }
  lines.push("");

  lines.push("## Release criteria");
  lines.push("");
  if (report.criteria.length === 0) {
    lines.push("- None declared.");
  } else {
    for (const c of report.criteria) {
      lines.push(renderCriterion(c));
    }
  }
  lines.push("");

  lines.push("## Environment requirements");
  lines.push("");
  if (report.environment.length === 0) {
    lines.push("- None declared.");
  } else {
    for (const e of report.environment) {
      lines.push(renderEnv(e));
    }
  }
  lines.push("");

  if (!report.passed) {
    lines.push("## Next steps");
    lines.push("");
    const todos = collectTodos(report);
    if (todos.length === 0) {
      lines.push("- No specific follow-ups — re-run the gate.");
    } else {
      for (const t of todos) lines.push(`- ${t}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function renderCriterion(c: AcceptanceReport["criteria"][number]): string {
  const icon =
    c.status === "covered" ? "✅" : c.status === "uncovered" ? "❌" : "⚠";
  const head = `- ${icon} \`${c.tag}\` — ${c.description || "(no description)"}`;
  const cite = c.coveringPlans.length
    ? `covered by ${c.coveringPlans
        .map(
          (p) => `${p.id}${p.status !== "completed" ? ` (${p.status})` : ""}`,
        )
        .join(", ")}`
    : "no covering plan";
  const testsNote = c.testPaths.length
    ? ` · tests: ${c.testPaths.map((t) => `\`${t}\``).join(", ")}`
    : "";
  const missingNote = c.missingTestPaths.length
    ? ` · missing test files: ${c.missingTestPaths
        .map((t) => `\`${t}\``)
        .join(", ")}`
    : "";
  const failNote =
    c.status === "covered-but-test-failed" && c.testRun
      ? ` · last test failed (${c.testRun.testPath})`
      : "";
  return `${head}\n  - ${cite}${testsNote}${missingNote}${failNote}`;
}

function renderEnv(e: AcceptanceReport["environment"][number]): string {
  const icon =
    e.status === "set" ? "✅" : e.status === "placeholder" ? "⚠" : "❌";
  const note =
    e.status === "set"
      ? "set in `.env.example`"
      : e.status === "placeholder"
        ? e.valueKind === "empty"
          ? "present in `.env.example` but empty"
          : "present in `.env.example` with placeholder value"
        : "missing from `.env.example`";
  return `- ${icon} \`${e.name}\` — ${note}`;
}

function collectTodos(report: AcceptanceReport): string[] {
  const todos: string[] = [];
  for (const c of report.criteria) {
    if (c.status === "uncovered") {
      todos.push(
        `Ship a plan with \`acceptance_tags: ["${c.tag}"]\` (criterion: ${c.description}).`,
      );
    } else if (c.status === "covered-but-test-missing") {
      todos.push(
        `Add the cited test file(s) for \`${c.tag}\`: ${c.missingTestPaths
          .map((t) => `\`${t}\``)
          .join(", ")}.`,
      );
    } else if (c.status === "covered-but-test-failed" && c.testRun) {
      todos.push(
        `Fix the failing test for \`${c.tag}\`: \`${c.testRun.testPath}\`.`,
      );
    }
  }
  for (const e of report.environment) {
    if (e.status === "missing-from-template") {
      todos.push(
        `Add \`${e.name}\` to \`.env.example\` with a working default or documented placeholder.`,
      );
    } else if (e.status === "placeholder") {
      todos.push(
        `Set a release-ready default for \`${e.name}\` in \`.env.example\`.`,
      );
    }
  }
  return todos;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
