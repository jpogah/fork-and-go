// Entry point for the release-gate CLI. Invoked via
// `./scripts/release-gate.sh` (wraps tsx). Exit codes:
//   0 — every criterion covered AND every env var set.
//   1 — gate failed (uncovered criterion, missing env, failed test).
//   2 — usage error (bad flag, missing file).
//
// Flags:
//   --spec <path>             Acceptance file (required).
//   --run-tests               Invoke each cited test via `npx vitest run`.
//   --dry-run                 Render the report to stdout; do not write
//                             `.orchestrator/release-reports/`.
//   --reports-dir <path>      Override the report output dir.
//   --env-template <path>     Override `.env.example`.
//   --quiet                   Only emit a one-line status to stdout.
//   -h / --help               Show usage.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runReleaseGate } from "@fork-and-go/release-gate";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ACTIVE_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "active");
const COMPLETED_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "completed");
const DEFAULT_REPORTS_DIR = path.join(
  REPO_ROOT,
  ".orchestrator",
  "release-reports",
);
const DEFAULT_ENV_TEMPLATE = path.join(REPO_ROOT, ".env.example");

interface ParsedArgs {
  specPath: string;
  runTests: boolean;
  dryRun: boolean;
  quiet: boolean;
  reportsDir: string;
  envTemplatePath: string;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: release-gate --spec <path> [options]",
    "",
    "Checks a product's acceptance file against the merged plan graph",
    "and `.env.example`. Writes a readiness report under",
    "`.orchestrator/release-reports/YYYY-MM-DD-<slug>.md`.",
    "",
    "Options:",
    "  --spec <path>         Acceptance markdown file (required).",
    "  --run-tests           Invoke each cited test via vitest.",
    "  --dry-run             Render the report to stdout without writing.",
    "  --reports-dir <dir>   Override report output directory.",
    "  --env-template <path> Override `.env.example`.",
    "  --quiet               Emit only a one-line status to stdout.",
    "  -h, --help            Show this help.",
    "",
    "Exit codes: 0 = ready, 1 = not ready, 2 = usage error.",
  ].join("\n");
}

function parseArgs(
  argv: ReadonlyArray<string>,
): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  let specPath: string | null = null;
  let runTests = false;
  let dryRun = false;
  let quiet = false;
  let reportsDir: string = DEFAULT_REPORTS_DIR;
  let envTemplatePath: string = DEFAULT_ENV_TEMPLATE;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--run-tests") {
      runTests = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--spec" || arg === "--spec-file") {
      const value = args[i + 1];
      if (value === undefined) return { error: `${arg} requires a value` };
      specPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      specPath = arg.slice("--spec=".length);
      continue;
    }
    if (arg === "--reports-dir") {
      const value = args[i + 1];
      if (value === undefined)
        return { error: "--reports-dir requires a value" };
      reportsDir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--reports-dir=")) {
      reportsDir = arg.slice("--reports-dir=".length);
      continue;
    }
    if (arg === "--env-template") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "--env-template requires a value" };
      }
      envTemplatePath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--env-template=")) {
      envTemplatePath = arg.slice("--env-template=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      return { error: `Unknown flag: ${arg}` };
    }
    return { error: `Unexpected positional argument: ${arg}` };
  }

  if (help) {
    return {
      specPath: "",
      runTests,
      dryRun,
      quiet,
      reportsDir,
      envTemplatePath,
      help: true,
    };
  }
  if (specPath === null) {
    return { error: "Missing required --spec <path> argument" };
  }

  return {
    specPath,
    runTests,
    dryRun,
    quiet,
    reportsDir,
    envTemplatePath,
    help: false,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`release-gate: ${parsed.error}\n\n${usage()}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const specAbs = path.isAbsolute(parsed.specPath)
    ? parsed.specPath
    : path.resolve(REPO_ROOT, parsed.specPath);
  const envAbs = path.isAbsolute(parsed.envTemplatePath)
    ? parsed.envTemplatePath
    : path.resolve(REPO_ROOT, parsed.envTemplatePath);
  const reportsAbs = path.isAbsolute(parsed.reportsDir)
    ? parsed.reportsDir
    : path.resolve(REPO_ROOT, parsed.reportsDir);

  const outcome = await runReleaseGate({
    specPath: specAbs,
    activeDir: ACTIVE_DIR,
    completedDir: COMPLETED_DIR,
    envTemplatePath: envAbs,
    reportsDir: reportsAbs,
    repoRoot: REPO_ROOT,
    runTests: parsed.runTests,
    writeReport: !parsed.dryRun,
  });

  if (!outcome.ok) {
    process.stderr.write(
      `release-gate: FAILED at ${outcome.stage} — ${outcome.reason}\n`,
    );
    return 1;
  }

  if (parsed.dryRun && !parsed.quiet) {
    process.stdout.write(outcome.renderedMarkdown);
  }

  if (!parsed.quiet) {
    if (outcome.writeResult) {
      process.stdout.write(
        `wrote ${path.relative(REPO_ROOT, outcome.writeResult.markdownPath)}\n`,
      );
    }
  }

  if (outcome.report.passed) {
    process.stdout.write(parsed.quiet ? "READY\n" : "release gate: READY ✓\n");
    return 0;
  }
  process.stdout.write(
    parsed.quiet ? "NOT_READY\n" : "release gate: NOT READY ✗\n",
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `release-gate: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  });
