// Entry point for the spec-fidelity checker CLI. Wraps `runFidelityCheck`
// from @fork-and-go/fidelity-check with env-based configuration so the script
// drops into the harness exactly the same way `plan.sh` does.
//
// Usage:
//   ./scripts/check-fidelity.sh --spec docs/product-specs/<name>.md [options]
//
// Exit codes:
//   0 — drift score is at or below the threshold (or --no-auto-suspend
//       preview mode where drift is reported without gating).
//   1 — drift score exceeded the threshold (or a runtime failure).
//   2 — usage error (missing arg, bad flag, missing env).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  BUILDER_DEFAULT_MODEL,
  BUILDER_REPAIR_MODEL,
  createModelClient,
} from "@fork-and-go/builder";
import { DEFAULT_THRESHOLD, runFidelityCheck } from "@fork-and-go/fidelity-check";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ACTIVE_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "active");
const COMPLETED_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "completed");
const REPORTS_DIR = path.join(REPO_ROOT, ".orchestrator", "fidelity-reports");
const CONFIG_PATH = path.join(
  REPO_ROOT,
  ".orchestrator",
  "fidelity-config.json",
);

interface ParsedArgs {
  specPath: string;
  threshold: number;
  autoSuspend: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: check-fidelity --spec <path> [options]",
    "",
    "Audits the built + in-progress work against a product spec and writes a",
    "drift report under .orchestrator/fidelity-reports/. Exits non-zero when the",
    "drift score exceeds the threshold.",
    "",
    "Options:",
    "  --spec <path>         Product spec markdown file (required).",
    "  --threshold <N>       Drift-score threshold (default: " +
      DEFAULT_THRESHOLD +
      ").",
    "  --no-auto-suspend     Write the report but don't block active plans or",
    "                        create 9999-fidelity-review.md, even on failure.",
    "  -h, --help            Show this help.",
    "",
    "Environment:",
    "  BUILDER_LLM_CLIENT            `cli` (default, spawns `codex exec`) or",
    "                                `openai` (requires OPENAI_API_KEY).",
    "  OPENAI_API_KEY                Required only when BUILDER_LLM_CLIENT=openai.",
    "  FIDELITY_DRIFT_THRESHOLD      Overrides the default threshold.",
    "  FIDELITY_MODEL                Default LLM model (falls back to BUILDER_MODEL).",
    "  FIDELITY_REPAIR_MODEL         Repair LLM model (falls back to BUILDER_REPAIR_MODEL).",
    "  .orchestrator/fidelity-config.json",
    '                                Optional JSON: { "threshold": N }',
  ].join("\n");
}

function parseArgs(
  argv: ReadonlyArray<string>,
): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  let specPath: string | null = null;
  let threshold: number | null = null;
  let autoSuspend = true;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--no-auto-suspend") {
      autoSuspend = false;
      continue;
    }
    if (arg === "--spec") {
      const value = args[i + 1];
      if (value === undefined) return { error: "--spec requires a value" };
      specPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      specPath = arg.slice("--spec=".length);
      continue;
    }
    if (arg === "--threshold") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "--threshold requires a value" };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return {
          error: `--threshold must be an integer 0..100, got ${value}`,
        };
      }
      threshold = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--threshold=")) {
      const value = arg.slice("--threshold=".length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return {
          error: `--threshold must be an integer 0..100, got ${value}`,
        };
      }
      threshold = parsed;
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
      threshold: DEFAULT_THRESHOLD,
      autoSuspend,
      help: true,
    };
  }
  if (specPath === null) {
    return { error: "Missing required --spec <path> argument" };
  }

  const resolvedThreshold =
    threshold ?? resolveDefaultThreshold() ?? DEFAULT_THRESHOLD;
  return {
    specPath,
    threshold: resolvedThreshold,
    autoSuspend,
    help: false,
  };
}

function resolveDefaultThreshold(): number | null {
  const envValue = process.env.FIDELITY_DRIFT_THRESHOLD;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error(
        `FIDELITY_DRIFT_THRESHOLD must be an integer 0..100, got ${envValue}`,
      );
    }
    return parsed;
  }
  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
        threshold?: unknown;
      };
      if (typeof parsed.threshold === "number") {
        if (parsed.threshold < 0 || parsed.threshold > 100) {
          throw new Error(
            `fidelity-config.json threshold must be 0..100, got ${parsed.threshold}`,
          );
        }
        return Math.floor(parsed.threshold);
      }
    } catch (err) {
      throw new Error(
        `invalid ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`check-fidelity: ${parsed.error}\n\n${usage()}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const specAbs = path.isAbsolute(parsed.specPath)
    ? parsed.specPath
    : path.resolve(REPO_ROOT, parsed.specPath);

  const defaultModel =
    process.env.FIDELITY_MODEL ||
    process.env.BUILDER_MODEL ||
    BUILDER_DEFAULT_MODEL;
  const repairModel =
    process.env.FIDELITY_REPAIR_MODEL ||
    process.env.BUILDER_REPAIR_MODEL ||
    BUILDER_REPAIR_MODEL;

  let modelClient;
  try {
    modelClient = createModelClient({
      cli: { defaultModel },
      openai: { defaultModel },
    });
  } catch (err) {
    process.stderr.write(
      `check-fidelity: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const outcome = await runFidelityCheck(
    {
      specPath: specAbs,
      activeDir: ACTIVE_DIR,
      completedDir: COMPLETED_DIR,
      reportsDir: REPORTS_DIR,
      repoRoot: REPO_ROOT,
      threshold: parsed.threshold,
      autoSuspend: parsed.autoSuspend,
    },
    {
      modelClient,
      defaultModel,
      repairModel,
    },
  );

  if (!outcome.ok) {
    process.stderr.write(
      `check-fidelity: FAILED at ${outcome.stage} — ${outcome.reason}\n`,
    );
    return 1;
  }

  const icon = outcome.exceedsThreshold ? "⚠ OVER" : "✓ OK";
  process.stdout.write(
    `drift score ${outcome.score}/100 (threshold ${outcome.threshold}) ${icon}\n`,
  );
  if (outcome.report.skipped) {
    process.stdout.write(
      `report skipped — ${outcome.report.skipReason ?? "identical to previous"}\n`,
    );
  } else {
    process.stdout.write(`wrote ${outcome.report.markdownPath}\n`);
    process.stdout.write(`wrote ${outcome.report.summaryPath}\n`);
  }
  if (outcome.suspension) {
    process.stdout.write(
      `auto-suspended ${outcome.suspension.blockedPlanIds.length} active plan(s); created ${outcome.suspension.metaPlanPath}\n`,
    );
  }

  if (outcome.exceedsThreshold) {
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `check-fidelity: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  });
