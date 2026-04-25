// Entry point for the planner CLI. Invoked via scripts/plan.sh, which wraps
// `tsx` so we can import the TypeScript source of @fork-and-go/planner directly.
//
// Usage:
//   ./scripts/plan.sh <spec-file> [--preview] [--max-new-plans N]
//
// The CLI is intentionally thin: it parses args, builds a live OpenAI client
// from env, wires a logger-backed audit sink, and defers to runPlanner.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { existsSync } from "node:fs";

import {
  BUILDER_DEFAULT_MODEL,
  BUILDER_REPAIR_MODEL,
  createModelClient,
} from "@fork-and-go/builder";
import {
  createLoggerPlannerAuditSink,
  DEFAULT_MAX_NEW_PLANS,
  runPlanner,
} from "@fork-and-go/planner";
import { parseAcceptanceFile } from "@fork-and-go/release-gate";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ACTIVE_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "active");
const COMPLETED_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "completed");
const CONTEXT_DIR = path.join(REPO_ROOT, "docs", "context");
const PLANS_MD_PATH = path.join(REPO_ROOT, "docs", "PLANS.md");

interface ParsedArgs {
  specPath: string;
  preview: boolean;
  maxNewPlans: number;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: plan <spec-file> [options]",
    "",
    "Reads a product spec (markdown), analyzes the current repo state, and emits",
    "execution plan files under docs/exec-plans/active/.",
    "",
    "Options:",
    "  --preview              Show proposals without writing files.",
    "  --max-new-plans <N>    Cap on new plans per run (default: " +
      DEFAULT_MAX_NEW_PLANS +
      ").",
    "  -h, --help             Show this help.",
    "",
    "Environment:",
    "  BUILDER_LLM_CLIENT     `cli` (default, spawns `codex exec`) or `openai`",
    "                         (requires OPENAI_API_KEY).",
    "  OPENAI_API_KEY         Required only when BUILDER_LLM_CLIENT=openai.",
    "  PLANNER_MODEL          Default model (falls back to BUILDER_MODEL).",
    "  PLANNER_REPAIR_MODEL   Repair model (falls back to BUILDER_REPAIR_MODEL).",
  ].join("\n");
}

function parseArgs(
  argv: ReadonlyArray<string>,
): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  let specPath: string | null = null;
  let preview = false;
  let maxNewPlans = DEFAULT_MAX_NEW_PLANS;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--preview") {
      preview = true;
      continue;
    }
    if (arg === "--max-new-plans") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "--max-new-plans requires a value" };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          error: `--max-new-plans requires a positive integer; got ${value}`,
        };
      }
      maxNewPlans = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-new-plans=")) {
      const value = arg.slice("--max-new-plans=".length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          error: `--max-new-plans requires a positive integer; got ${value}`,
        };
      }
      maxNewPlans = parsed;
      continue;
    }
    if (arg === "--spec-file") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "--spec-file requires a value" };
      }
      specPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return { error: `Unknown flag: ${arg}` };
    }
    if (specPath === null) {
      specPath = arg;
    } else {
      return { error: `Unexpected positional argument: ${arg}` };
    }
  }

  if (help) {
    return { specPath: "", preview, maxNewPlans, help: true };
  }
  if (specPath === null) {
    return { error: "Missing required <spec-file> argument" };
  }
  return { specPath, preview, maxNewPlans, help: false };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`plan: ${parsed.error}\n\n${usage()}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const defaultModel =
    process.env.PLANNER_MODEL ??
    process.env.BUILDER_MODEL ??
    BUILDER_DEFAULT_MODEL;
  const repairModel =
    process.env.PLANNER_REPAIR_MODEL ??
    process.env.BUILDER_REPAIR_MODEL ??
    BUILDER_REPAIR_MODEL;

  let modelClient;
  try {
    modelClient = createModelClient({
      cli: { defaultModel },
      openai: { defaultModel },
    });
  } catch (err) {
    process.stderr.write(
      `plan: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const specAbs = path.resolve(REPO_ROOT, parsed.specPath);

  // Plan 0054: if a sibling `<spec>.acceptance.md` exists, feed its tag list
  // into the planner so emitted plans come with `acceptance_tags` populated
  // by the decompose LLM. Silent on absence — specs without acceptance
  // files still plan normally.
  const acceptancePath = deriveAcceptancePath(specAbs);
  const acceptanceTags = acceptancePath
    ? parseAcceptanceFile(acceptancePath).criteria.map((c) => ({
        tag: c.tag,
        description: c.description,
      }))
    : [];

  const auditSink = createLoggerPlannerAuditSink({
    logger: (line) => process.stderr.write(line + "\n"),
  });

  const outcome = await runPlanner(
    {
      specPath: specAbs,
      activeDir: ACTIVE_DIR,
      completedDir: COMPLETED_DIR,
      contextDir: CONTEXT_DIR,
      repoRoot: REPO_ROOT,
      mode: parsed.preview ? "preview" : "emit",
      maxNewPlans: parsed.maxNewPlans,
      ...(parsed.preview ? {} : { plansMdPath: PLANS_MD_PATH }),
      ...(acceptanceTags.length > 0 ? { acceptanceTags } : {}),
    },
    {
      modelClient,
      auditSink,
      defaultModel,
      repairModel,
    },
  );

  for (const warning of outcome.contextWarnings) {
    process.stderr.write(
      `plan: context warning — ${warning.filename}: ${warning.reason}\n`,
    );
  }

  if (!outcome.ok) {
    process.stderr.write(
      `plan: FAILED at ${outcome.stage} — ${outcome.reason}\n`,
    );
    return 1;
  }

  const { result } = outcome;
  if (result.mode === "preview") {
    process.stdout.write("Preview — proposals (no files written):\n");
    for (const proposal of result.proposals) {
      process.stdout.write(
        `  ${proposal.id}\t${proposal.phase}\t${proposal.title}\n`,
      );
      process.stdout.write(
        `    depends_on: [${proposal.depends_on.join(", ")}]\n`,
      );
      process.stdout.write(`    summary:    ${proposal.summary}\n`);
    }
    process.stdout.write(`\nTo emit these plans, rerun without --preview.\n`);
  } else {
    for (const written of result.emitted) {
      process.stdout.write(`wrote ${written.filePath}\n`);
    }
    if (result.skipped.length > 0) {
      process.stdout.write(
        `skipped ${result.skipped.length} proposal(s) already present as completed plans\n`,
      );
    }
    if (result.emitted.length > 0) {
      process.stdout.write(`regenerated ${PLANS_MD_PATH}\n`);
    }
  }

  return 0;
}

function deriveAcceptancePath(specAbs: string): string | null {
  const dir = path.dirname(specAbs);
  const baseNoExt = path.basename(specAbs, path.extname(specAbs));
  // Two naming conventions: `<spec>.acceptance.md` (paired sibling) and a
  // spec that already has the `.acceptance.md` suffix (no-op).
  if (baseNoExt.endsWith(".acceptance")) return null;
  const candidate = path.join(dir, `${baseNoExt}.acceptance.md`);
  return existsSync(candidate) ? candidate : null;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `plan: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  });
