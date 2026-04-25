// Entry point for the URL-to-app reverse-engineering CLI.
//
// Usage:
//   ./scripts/reverse-site.sh <url> [--name slug] [--planner-preview]
//
// The CLI captures a public site with Playwright, asks the harness model
// client to synthesize an improved rebuild spec, writes the evidence bundle,
// then hands the generated spec to the existing planner unless --no-plan is
// passed.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  MODEL_CLIENT_DEFAULT_MODEL,
  MODEL_CLIENT_REPAIR_MODEL,
  createModelClient,
} from "@fork-and-go/model-client";
import {
  SiteReverseError,
  defaultSlugFromUrl,
  runSiteReverse,
  type SiteReversePlannerMode,
  type ViewportName,
} from "@fork-and-go/site-reverse";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

interface ParsedArgs {
  url: string;
  slug?: string;
  maxPages?: number;
  viewports?: ReadonlyArray<ViewportName>;
  notesPath?: string;
  plannerMode: SiteReversePlannerMode;
  maxNewPlans?: number;
  force: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: reverse-site <url> [options]",
    "",
    "Captures a public website, generates an improved-rebuild product spec,",
    "writes source evidence under docs/context/site-reverse/, and runs the",
    "existing planner against the generated spec by default.",
    "",
    "Options:",
    "  --name <slug>          Output slug (default: derived from URL).",
    "  --max-pages <N>        Same-origin pages to capture (default: 5).",
    "  --viewport <mode>      desktop, mobile, or both (default: both).",
    "  --notes <file>         Extra operator notes for gated flows.",
    "  --planner-preview      Run planner preview instead of writing plans.",
    "  --no-plan              Generate evidence and spec only.",
    "  --max-new-plans <N>    Cap planner proposals (planner default if omitted).",
    "  --force                Overwrite generated files for the slug.",
    "  -h, --help             Show this help.",
    "",
    "Environment:",
    "  FORK_AND_GO_LLM_CLIENT       `cli` (default, spawns `codex exec`) or `openai`.",
    "  SITE_REVERSE_MODEL           Default model (falls back to FORK_AND_GO_MODEL).",
    "  SITE_REVERSE_REPAIR_MODEL    Repair model (falls back to FORK_AND_GO_REPAIR_MODEL).",
    "",
    "Playwright:",
    "  Run `npx playwright install chromium` once if Chromium is not installed.",
  ].join("\n");
}

function parseArgs(
  argv: ReadonlyArray<string>,
): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  let url: string | null = null;
  let slug: string | undefined;
  let maxPages: number | undefined;
  let viewports: ReadonlyArray<ViewportName> | undefined;
  let notesPath: string | undefined;
  let plannerMode: SiteReversePlannerMode = "emit";
  let maxNewPlans: number | undefined;
  let force = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--planner-preview") {
      plannerMode = "preview";
      continue;
    }
    if (arg === "--no-plan") {
      plannerMode = "skip";
      continue;
    }
    if (arg === "--name") {
      const value = args[index + 1];
      if (value === undefined) return { error: "--name requires a value" };
      slug = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      slug = arg.slice("--name=".length);
      continue;
    }
    if (arg === "--notes") {
      const value = args[index + 1];
      if (value === undefined) return { error: "--notes requires a value" };
      notesPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--notes=")) {
      notesPath = arg.slice("--notes=".length);
      continue;
    }
    if (arg === "--viewport") {
      const value = args[index + 1];
      if (value === undefined) return { error: "--viewport requires a value" };
      const parsed = parseViewport(value);
      if ("error" in parsed) return parsed;
      viewports = parsed.viewports;
      index += 1;
      continue;
    }
    if (arg.startsWith("--viewport=")) {
      const parsed = parseViewport(arg.slice("--viewport=".length));
      if ("error" in parsed) return parsed;
      viewports = parsed.viewports;
      continue;
    }
    if (arg === "--max-pages") {
      const value = args[index + 1];
      if (value === undefined) return { error: "--max-pages requires a value" };
      const parsed = parsePositiveInt("--max-pages", value);
      if ("error" in parsed) return parsed;
      maxPages = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      const parsed = parsePositiveInt(
        "--max-pages",
        arg.slice("--max-pages=".length),
      );
      if ("error" in parsed) return parsed;
      maxPages = parsed.value;
      continue;
    }
    if (arg === "--max-new-plans") {
      const value = args[index + 1];
      if (value === undefined) {
        return { error: "--max-new-plans requires a value" };
      }
      const parsed = parsePositiveInt("--max-new-plans", value);
      if ("error" in parsed) return parsed;
      maxNewPlans = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-new-plans=")) {
      const parsed = parsePositiveInt(
        "--max-new-plans",
        arg.slice("--max-new-plans=".length),
      );
      if ("error" in parsed) return parsed;
      maxNewPlans = parsed.value;
      continue;
    }
    if (arg.startsWith("--")) {
      return { error: `Unknown flag: ${arg}` };
    }
    if (url === null) {
      url = arg;
    } else {
      return { error: `Unexpected positional argument: ${arg}` };
    }
  }

  if (help) {
    return { url: "", plannerMode, force, help: true };
  }
  if (url === null) {
    return { error: "Missing required <url> argument" };
  }

  return {
    url,
    ...(slug !== undefined ? { slug } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(viewports !== undefined ? { viewports } : {}),
    ...(notesPath !== undefined ? { notesPath } : {}),
    plannerMode,
    ...(maxNewPlans !== undefined ? { maxNewPlans } : {}),
    force,
    help: false,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`reverse-site: ${parsed.error}\n\n${usage()}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const defaultModel =
    process.env.SITE_REVERSE_MODEL ??
    process.env.FORK_AND_GO_MODEL ??
    MODEL_CLIENT_DEFAULT_MODEL;
  const repairModel =
    process.env.SITE_REVERSE_REPAIR_MODEL ??
    process.env.FORK_AND_GO_REPAIR_MODEL ??
    MODEL_CLIENT_REPAIR_MODEL;

  let modelClient;
  try {
    modelClient = createModelClient({
      cli: { defaultModel },
      openai: { defaultModel },
    });
  } catch (err) {
    process.stderr.write(
      `reverse-site: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const slug = parsed.slug ?? defaultSlugFromUrl(parsed.url);
  try {
    const result = await runSiteReverse(
      {
        sourceUrl: parsed.url,
        slug,
        repoRoot: REPO_ROOT,
        ...(parsed.maxPages !== undefined
          ? { maxPages: parsed.maxPages }
          : {}),
        ...(parsed.viewports !== undefined
          ? { viewports: parsed.viewports }
          : {}),
        ...(parsed.notesPath !== undefined
          ? { notesPath: parsed.notesPath }
          : {}),
        plannerMode: parsed.plannerMode,
        ...(parsed.maxNewPlans !== undefined
          ? { maxNewPlans: parsed.maxNewPlans }
          : {}),
        force: parsed.force,
      },
      {
        modelClient,
        defaultModel,
        repairModel,
        logger: (line) => process.stderr.write(line + "\n"),
      },
    );

    process.stdout.write(`wrote ${result.paths.specPath}\n`);
    process.stdout.write(`wrote ${result.paths.bundleDir}\n`);
    process.stdout.write(`wrote ${result.paths.contextDropPath}\n`);
    if (result.plannerOutcome) {
      if (!result.plannerOutcome.ok) {
        process.stderr.write(
          `reverse-site: planner failed at ${result.plannerOutcome.stage}: ${result.plannerOutcome.reason}\n`,
        );
        return 1;
      }
      const plannerResult = result.plannerOutcome.result;
      if (plannerResult.mode === "preview") {
        process.stdout.write(
          `planner preview produced ${plannerResult.proposals.length} proposal(s)\n`,
        );
      } else {
        for (const written of plannerResult.emitted) {
          process.stdout.write(`wrote ${written.filePath}\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    const prefix = err instanceof SiteReverseError ? "reverse-site" : "error";
    process.stderr.write(
      `${prefix}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function parseViewport(
  value: string,
): { viewports: ReadonlyArray<ViewportName> } | { error: string } {
  if (value === "both") return { viewports: ["desktop", "mobile"] };
  if (value === "desktop" || value === "mobile") return { viewports: [value] };
  return { error: `--viewport must be desktop, mobile, or both; got ${value}` };
}

function parsePositiveInt(
  flag: string,
  value: string,
): { value: number } | { error: string } {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: `${flag} requires a positive integer; got ${value}` };
  }
  return { value: parsed };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `reverse-site: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  });
