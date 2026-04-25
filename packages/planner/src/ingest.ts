// Ingest phase: pure-data, no LLM. Reads the product spec, every existing
// plan's frontmatter, and any checked-in "context drops" (0051 — operator
// drops markdown files with YAML frontmatter into `docs/context/inbox/`)
// into a single `PlanningContext` object the decompose phase will compress
// into prompt input.
//
// No network calls, no writes. Deterministic given the same filesystem state.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  loadContextInbox,
  matchContext,
  UNTRUSTED_LABEL,
  type ContextParseWarning,
} from "@fork-and-go/context-ingest";
import { loadPlans, type Plan } from "@fork-and-go/plan-graph";

export interface PlanningContext {
  spec: {
    path: string;
    content: string;
  };
  plans: ReadonlyArray<PlanSummary>;
  contextDrops: ReadonlyArray<ContextDrop>;
  // Parse-time warnings from the context inbox — malformed frontmatter,
  // unreadable files. Advisory; the planner surfaces these on stderr but
  // does not abort on them.
  contextWarnings: ReadonlyArray<ContextParseWarning>;
  // Highest existing plan id as a numeric value. The decompose phase uses
  // this to allocate new zero-padded ids without colliding.
  highestPlanIdNumeric: number;
  // Plan 0054: optional seed list of acceptance tags + descriptions from
  // the paired acceptance file. Absent or empty when the caller did not
  // supply an acceptance file. The decompose prompt surfaces these so the
  // LLM can populate `acceptance_tags` on each proposal it emits.
  acceptanceTags?: ReadonlyArray<{ tag: string; description: string }>;
  repoRoot: string;
}

export interface PlanSummary {
  id: string;
  title: string;
  phase: string;
  status: Plan["status"];
  location: Plan["location"];
  dependsOn: ReadonlyArray<string>;
  estimatedPasses: number;
  // A short one-line excerpt from the plan body — the first non-heading,
  // non-blank line — so the LLM can tell plans apart without pulling the
  // whole body into the prompt.
  blurb: string;
}

export interface ContextDrop {
  filename: string;
  content: string;
}

export interface IngestOptions {
  specPath: string;
  activeDir: string;
  completedDir: string;
  // Root of the `docs/context/` convention (0051). The ingest reads
  // `<contextDir>/inbox/*.md`, parses the `source` / `scope` frontmatter,
  // and includes the bodies whose scope resolves to `all` or `planner`.
  // Larger files are truncated and a per-prompt aggregate cap is enforced
  // by the matcher in @fork-and-go/context-ingest.
  contextDir?: string;
  // Plan 0054: paired acceptance file. When provided, the ingest passes
  // the tag+description list to the decompose prompt so the LLM can claim
  // the right tags on each proposal. Already-resolved by the caller — the
  // ingest does not re-parse the acceptance file.
  acceptanceTags?: ReadonlyArray<{ tag: string; description: string }>;
  repoRoot: string;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

export function ingest(options: IngestOptions): PlanningContext {
  if (!existsSync(options.specPath)) {
    throw new IngestError(`Spec file not found: ${options.specPath}`);
  }
  const specContent = readFileSync(options.specPath, "utf8");

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
    estimatedPasses: plan.estimatedPasses,
    blurb: extractBlurb(plan.body),
  }));

  const { drops: contextDrops, warnings: contextWarnings } = options.contextDir
    ? loadPlannerContextDrops(options.contextDir)
    : { drops: [], warnings: [] };

  const highestPlanIdNumeric = plans.reduce((max, plan) => {
    const value = Number.parseInt(plan.id, 10);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);

  return {
    spec: {
      path: options.specPath,
      content: specContent,
    },
    plans: summaries,
    contextDrops,
    contextWarnings,
    highestPlanIdNumeric,
    acceptanceTags: options.acceptanceTags ?? [],
    repoRoot: options.repoRoot,
  };
}

function loadPlannerContextDrops(contextDir: string): {
  drops: ContextDrop[];
  warnings: ContextParseWarning[];
} {
  const inboxDir = path.join(contextDir, "inbox");
  const { files, warnings } = loadContextInbox({ inboxDir });
  // Planner phase sees only `all`- or `planner`-scoped drops. Size caps and
  // priority ordering are enforced by the shared matcher so the planner's
  // view matches what the runner will inject into implementer prompts.
  const matched = matchContext(files, { kind: "planner" });
  const drops: ContextDrop[] = matched.matched.map((m) => ({
    filename: m.file.filename,
    content: composeContextDropContent(m.file, m.truncatedBy),
  }));
  return { drops, warnings: [...warnings] };
}

function composeContextDropContent(
  file: { header: { source: string; scope: string }; body: string },
  truncatedBy: number,
): string {
  // The UNTRUSTED_LABEL rides with each drop so the decomposer sees the same
  // prompt-injection boundary the runner injects into implementer prompts —
  // the system prompt's fence only covers the product spec, not contextDrops.
  const header = `${UNTRUSTED_LABEL}\n<!-- source=${file.header.source}, scope=${file.header.scope} -->`;
  const trimmed = file.body.trimEnd();
  if (truncatedBy > 0) {
    return `${header}\n${trimmed}\n\n[Truncated ${truncatedBy} characters.]`;
  }
  return `${header}\n${trimmed}`;
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

export function nextPlanIdAfter(highest: number): string {
  const next = highest + 1;
  return next.toString().padStart(4, "0");
}
