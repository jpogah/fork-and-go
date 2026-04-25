import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ModelClient } from "@fork-and-go/model-client";
import {
  DEFAULT_MAX_NEW_PLANS,
  createLoggerPlannerAuditSink,
  runPlanner,
  type PlannerRunOutcome,
  type PlannerRunOptions,
} from "@fork-and-go/planner";

import {
  analyzeCapturedSite as defaultAnalyzeCapturedSite,
  type AnalyzeCapturedSiteResult,
} from "./analyze.ts";
import { writeSiteReverseBundle as defaultWriteSiteReverseBundle } from "./bundle.ts";
import { captureSite as defaultCaptureSite } from "./capture.ts";
import { renderProductSpec } from "./spec.ts";
import type {
  SiteCapture,
  SiteCaptureOptions,
  SiteReverseResult,
  SiteReverseWritePaths,
  ViewportName,
} from "./types.ts";
import { assertSafeSlug, defaultSlugFromUrl, SiteReverseError } from "./url.ts";

export type SiteReversePlannerMode = "emit" | "preview" | "skip";

export interface RunSiteReverseOptions {
  sourceUrl: string;
  slug?: string;
  repoRoot: string;
  maxPages?: number;
  viewports?: ReadonlyArray<ViewportName>;
  notesPath?: string;
  plannerMode?: SiteReversePlannerMode;
  maxNewPlans?: number;
  force?: boolean;
  clock?: () => Date;
}

export interface RunSiteReverseDeps {
  modelClient: ModelClient;
  captureSite?: (options: SiteCaptureOptions) => Promise<SiteCapture>;
  analyzeCapturedSite?: typeof defaultAnalyzeCapturedSite;
  writeSiteReverseBundle?: typeof defaultWriteSiteReverseBundle;
  planner?: typeof runPlanner;
  logger?: (line: string) => void;
  defaultModel?: string;
  repairModel?: string;
}

export interface RunSiteReverseResult
  extends Omit<SiteReverseResult, "plannerOutcome"> {
  plannerOutcome?: PlannerRunOutcome;
  analysisAttempts: AnalyzeCapturedSiteResult["attempts"];
  analysisUsage: AnalyzeCapturedSiteResult["totalUsage"];
}

export async function runSiteReverse(
  options: RunSiteReverseOptions,
  deps: RunSiteReverseDeps,
): Promise<RunSiteReverseResult> {
  const slug = options.slug ?? defaultSlugFromUrl(options.sourceUrl);
  assertSafeSlug(slug);
  const repoRoot = path.resolve(options.repoRoot);
  const operatorNotes = readOptionalNotes(options.notesPath, repoRoot);
  const plannerMode = options.plannerMode ?? "emit";
  const captureSite = deps.captureSite ?? defaultCaptureSite;
  const analyzeCapturedSite =
    deps.analyzeCapturedSite ?? defaultAnalyzeCapturedSite;
  const writeSiteReverseBundle =
    deps.writeSiteReverseBundle ?? defaultWriteSiteReverseBundle;

  deps.logger?.(`site-reverse: capturing ${options.sourceUrl}`);
  const capture = await captureSite({
    url: options.sourceUrl,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.viewports !== undefined ? { viewports: options.viewports } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  deps.logger?.("site-reverse: analyzing captured evidence");
  const analysisResult = await analyzeCapturedSite(
    { capture, ...(operatorNotes ? { operatorNotes } : {}) },
    {
      modelClient: deps.modelClient,
      ...(deps.defaultModel !== undefined
        ? { defaultModel: deps.defaultModel }
        : {}),
      ...(deps.repairModel !== undefined ? { repairModel: deps.repairModel } : {}),
    },
  );
  const productSpec = renderProductSpec({
    slug,
    capture,
    analysis: analysisResult.analysis,
    ...(operatorNotes ? { operatorNotes } : {}),
  });

  deps.logger?.("site-reverse: writing evidence bundle and product spec");
  const paths: SiteReverseWritePaths = writeSiteReverseBundle({
    repoRoot,
    slug,
    capture,
    analysis: analysisResult.analysis,
    productSpec,
    force: options.force ?? false,
  });

  let plannerOutcome: PlannerRunOutcome | undefined;
  if (plannerMode !== "skip") {
    deps.logger?.(`site-reverse: running planner in ${plannerMode} mode`);
    const planner = deps.planner ?? runPlanner;
    plannerOutcome = await planner(buildPlannerOptions(repoRoot, paths, {
      mode: plannerMode,
      maxNewPlans: options.maxNewPlans,
    }), {
      modelClient: deps.modelClient,
      auditSink: createLoggerPlannerAuditSink({
        logger: deps.logger,
      }),
      ...(deps.defaultModel !== undefined
        ? { defaultModel: deps.defaultModel }
        : {}),
      ...(deps.repairModel !== undefined ? { repairModel: deps.repairModel } : {}),
    });
  }

  return {
    capture,
    analysis: analysisResult.analysis,
    analysisAttempts: analysisResult.attempts,
    analysisUsage: analysisResult.totalUsage,
    productSpec,
    paths,
    ...(plannerOutcome !== undefined ? { plannerOutcome } : {}),
  };
}

function buildPlannerOptions(
  repoRoot: string,
  paths: SiteReverseWritePaths,
  options: {
    mode: Exclude<SiteReversePlannerMode, "skip">;
    maxNewPlans?: number;
  },
): PlannerRunOptions {
  const mode = options.mode;
  return {
    specPath: paths.specPath,
    activeDir: path.join(repoRoot, "docs", "exec-plans", "active"),
    completedDir: path.join(repoRoot, "docs", "exec-plans", "completed"),
    contextDir: path.join(repoRoot, "docs", "context"),
    repoRoot,
    mode,
    maxNewPlans: options.maxNewPlans ?? DEFAULT_MAX_NEW_PLANS,
    ...(mode === "emit"
      ? { plansMdPath: path.join(repoRoot, "docs", "PLANS.md") }
      : {}),
  };
}

function readOptionalNotes(
  notesPath: string | undefined,
  repoRoot: string,
): string | undefined {
  if (notesPath === undefined) return undefined;
  const absPath = path.resolve(repoRoot, notesPath);
  if (!existsSync(absPath)) {
    throw new SiteReverseError(`Notes file not found: ${notesPath}`);
  }
  const notes = readFileSync(absPath, "utf8").trim();
  return notes.length > 0 ? notes : undefined;
}
