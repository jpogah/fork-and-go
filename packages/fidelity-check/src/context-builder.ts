// Context builder: gathers the deterministic, pure-filesystem view the
// audit LLM needs to reason about drift. No network, no LLM — same pattern
// as the planner's ingest.ts so the checker can be unit-tested against a
// mock repo fixture.
//
// We intentionally gather a "slice" rather than the whole repo: file
// listings (not contents) for app/ and packages/, a route manifest from
// apps/web/app/api/, and the previous report's summary JSON so the LLM
// can detect worsening-over-time drift without re-parsing markdown.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

import { loadPlans, type Plan } from "@fork-and-go/plan-graph";

export interface FidelityContext {
  spec: {
    path: string;
    slug: string;
    content: string;
  };
  plans: ReadonlyArray<PlanSummary>;
  repoSlice: {
    appFiles: ReadonlyArray<string>;
    packageFiles: ReadonlyArray<string>;
    apiRoutes: ReadonlyArray<string>;
    testFiles: ReadonlyArray<string>;
  };
  previousSummary: unknown | null;
  repoRoot: string;
}

export interface PlanSummary {
  id: string;
  title: string;
  phase: string;
  status: Plan["status"];
  location: Plan["location"];
  dependsOn: ReadonlyArray<string>;
  acceptanceTags: ReadonlyArray<string>;
  blurb: string;
}

export interface BuildContextOptions {
  specPath: string;
  activeDir: string;
  completedDir: string;
  repoRoot: string;
  // Optional path to the previous JSON summary. When present, the content
  // is parsed and exposed as `previousSummary` for the LLM to reference.
  previousSummaryPath?: string;
}

export class FidelityContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FidelityContextError";
  }
}

// Caps so even a giant monorepo can't blow out the prompt. We list file
// paths (not contents), so these are generous.
const MAX_FILES_PER_CATEGORY = 400;
const MAX_SPEC_BYTES = 64_000;

export function buildContext(options: BuildContextOptions): FidelityContext {
  if (!existsSync(options.specPath)) {
    throw new FidelityContextError(`Spec file not found: ${options.specPath}`);
  }
  const rawSpec = readFileSync(options.specPath, "utf8");
  const specContent =
    rawSpec.length > MAX_SPEC_BYTES
      ? rawSpec.slice(0, MAX_SPEC_BYTES) + "\n\n[Truncated.]"
      : rawSpec;
  const specSlug = path
    .basename(options.specPath, path.extname(options.specPath))
    .toLowerCase();

  const plans = loadPlans({
    activeDir: options.activeDir,
    completedDir: options.completedDir,
  });

  const summaries = plans.map<PlanSummary>((plan) => ({
    id: plan.id,
    title: plan.title,
    phase: plan.phase,
    status: plan.status,
    location: plan.location,
    dependsOn: plan.dependsOn,
    acceptanceTags: plan.acceptanceTags,
    blurb: extractBlurb(plan.body),
  }));

  const appFiles = listFiles(
    path.join(options.repoRoot, "apps", "web", "app"),
    options.repoRoot,
    MAX_FILES_PER_CATEGORY,
  );
  const packageFiles = listFiles(
    path.join(options.repoRoot, "packages"),
    options.repoRoot,
    MAX_FILES_PER_CATEGORY,
    { subDir: "src" },
  );
  const apiRoutes = appFiles.filter(
    (f) => f.includes("/api/") && f.endsWith("route.ts"),
  );
  const testFiles = packageFiles
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .slice(0, MAX_FILES_PER_CATEGORY);

  let previousSummary: unknown | null = null;
  if (options.previousSummaryPath && existsSync(options.previousSummaryPath)) {
    try {
      const text = readFileSync(options.previousSummaryPath, "utf8");
      previousSummary = JSON.parse(text);
    } catch {
      previousSummary = null;
    }
  }

  return {
    spec: { path: options.specPath, slug: specSlug, content: specContent },
    plans: summaries,
    repoSlice: {
      appFiles,
      packageFiles,
      apiRoutes,
      testFiles,
    },
    previousSummary,
    repoRoot: options.repoRoot,
  };
}

function listFiles(
  root: string,
  repoRoot: string,
  limit: number,
  opts: { subDir?: string } = {},
): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && results.length < limit) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // For packages/, we only want src/ files per the plan. The simplest
        // contract: descend only into matching subdirectories once we are
        // inside a top-level package.
        if (opts.subDir) {
          const rel = path.relative(root, full).split(path.sep);
          if (rel.length === 1) {
            stack.push(full);
            continue;
          }
          if (rel[1] !== opts.subDir) continue;
        }
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(full).size > 1_000_000) continue;
      } catch {
        continue;
      }
      results.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  }
  results.sort();
  return results;
}

function extractBlurb(body: string): string {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("```")) continue;
    if (trimmed.length > 220) return trimmed.slice(0, 217) + "...";
    return trimmed;
  }
  return "";
}
