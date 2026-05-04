// In-process replacement for scripts/run_task.sh + scripts/run_task_loop.sh.
// `runTask()` is the single entry point the orchestrator daemon (and the
// `harness run` CLI) call. It resolves the plan, sets up the per-run
// directory, ensures the task branch, and dispatches the requested phase
// (or the full chain when phase = "all").
//
// Repo-agnostic by construction: every path is anchored at
// `options.repoRoot` and every behavior knob comes from
// `options.config: HarnessConfig`. There is no hardcoded `apps/web`,
// `docs/exec-plans`, or `npm run dev` anywhere in this module tree.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createAgentRunner } from "@harness/agent-runner";
import { resolvePaths } from "@harness/config";

import {
  ensureBranch,
  ghReady,
  gitHasOrigin,
  hasDiffAgainstBase,
  hasUncommittedChanges,
  viewCurrentPr,
  commitAll,
} from "./git.ts";
import {
  runE2eVerify,
  runFix,
  runImplement,
  runMergeCheck,
  runPreparePr,
  runReview,
  runReviewFixLoop,
  runReviewUi,
} from "./phases.ts";
import { reviewIsClean } from "./sentinels.ts";
import type {
  Phase,
  RunContext,
  RunTaskOptions,
  RunTaskOutcome,
  TokensRecord,
} from "./types.ts";

export type {
  Phase,
  RunContext,
  RunTaskOptions,
  RunTaskOutcome,
  TokensRecord,
};

const ALL_PHASES: ReadonlyArray<Phase> = [
  "all",
  "implement",
  "review",
  "review-ui",
  "fix",
  "prepare-pr",
  "e2e-verify",
  "merge-check",
];

export async function runTask(
  options: RunTaskOptions,
): Promise<RunTaskOutcome> {
  const phase: Phase = options.phase ?? "all";
  if (!ALL_PHASES.includes(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }
  const paths = resolvePaths(options.repoRoot, options.config);
  const planResolution = resolvePlan(paths.planDir, options.taskRef);

  // Freeze gate: refuse to start if `.orchestrator/FROZEN` exists.
  const frozenFile = path.join(paths.stateDir, "FROZEN");
  if (existsSync(frozenFile)) {
    return {
      ok: false,
      planId: planResolution.planId,
      branch: `task/${planResolution.planSlug}`,
      runDir: "",
      logPath: "",
      reason: `harness is frozen (${frozenFile} exists). Remove the file or POST /unfreeze.`,
    };
  }

  // Ensure the state dir is self-ignoring so it never trips git's clean-tree
  // checks during phase dispatch. Writing `*` into `<stateDir>/.gitignore`
  // makes git treat every file under the state dir (including itself) as
  // ignored, so the directory becomes invisible to `git status`. We do this
  // even when the target repo's top-level .gitignore already lists the
  // stateDir — belt-and-suspenders, and it lets repos drop in the harness
  // without adjusting their existing .gitignore.
  mkdirSync(paths.stateDir, { recursive: true });
  const stateGitignore = path.join(paths.stateDir, ".gitignore");
  if (!existsSync(stateGitignore)) {
    writeFileSync(stateGitignore, "*\n", "utf8");
  }

  const runId = makeRunId();
  const runDir = path.join(paths.taskRunsDir, planResolution.planId, runId);
  mkdirSync(runDir, { recursive: true });
  // Friendly latest symlink — best-effort; ignored on failure.
  try {
    const latestLink = path.join(paths.taskRunsDir, planResolution.planId, "latest");
    await import("node:fs").then((fs) => {
      try {
        fs.unlinkSync(latestLink);
      } catch {
        /* not present */
      }
      fs.symlinkSync(runDir, latestLink);
    });
  } catch {
    /* ignore on FS that doesn't support symlinks */
  }

  const logPath = path.join(paths.logsDir, `${planResolution.planId}-${runId}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, "", "utf8");

  const baseLogger = options.logger;
  const log = (line: string): void => {
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    try {
      appendFileSync(logPath, stamped, "utf8");
    } catch {
      // log writing is best-effort
    }
    baseLogger?.(line);
  };

  // Resolve agent runner.
  const runner =
    options.agentRunner ??
    createAgentRunner({
      provider: options.config.agent.provider,
      ...(options.config.agent.model
        ? { model: options.config.agent.model }
        : {}),
      ...(options.config.agent.reasoningEffort
        ? { reasoningEffort: options.config.agent.reasoningEffort }
        : {}),
    });

  const branch = `task/${planResolution.planSlug}`;
  const ctx: RunContext = {
    planId: planResolution.planId,
    planSlug: planResolution.planSlug,
    planPath: planResolution.planPath,
    planRel: path.relative(options.repoRoot, planResolution.planPath),
    planTitle: planResolution.planTitle,
    planPhase: planResolution.planPhase,
    branch,
    repoRoot: options.repoRoot,
    runDir,
    runId,
    logPath,
    config: options.config,
    baseBranch: options.config.baseBranch,
    localOnly:
      options.localOnly ??
      !((await gitHasOrigin(options.repoRoot)) && (await ghReady(options.repoRoot))),
    skipE2e: options.skipE2e ?? false,
    maxReviewPasses:
      options.maxReviewPasses ?? options.config.agent.maxReviewPasses,
    dryRun: options.dryRun ?? false,
    runner,
    log,
    tokensUsed: [],
  };

  log(`run ${runId} starting phase=${phase} branch=${branch}`);
  if (ctx.localOnly) log("local-only mode: skipping push, PR, and merge ops");

  try {
    if (
      phase === "all" ||
      phase === "implement" ||
      phase === "review" ||
      phase === "review-ui" ||
      phase === "fix" ||
      phase === "prepare-pr" ||
      phase === "merge-check" ||
      phase === "e2e-verify"
    ) {
      await ensureBranch(options.repoRoot, branch, ctx.baseBranch);
      // Early-exit when the branch's PR has already been merged.
      if (!ctx.localOnly && !ctx.dryRun) {
        const pr = await viewCurrentPr(options.repoRoot);
        if (pr?.state === "MERGED") {
          log(`PR for ${branch} is already merged; nothing to do.`);
          return {
            ok: true,
            planId: ctx.planId,
            branch,
            runDir,
            logPath,
            phasesRun: [],
            tokensTotal: { inputTokens: 0, outputTokens: 0 },
          };
        }
      }
    }

    const phasesRun: Phase[] = [];
    let lastResult: { ok: boolean; output: string; rateLimited?: boolean } = {
      ok: true,
      output: "",
    };

    if (options.resume) {
      // Resume path: re-enter the review/fix loop against the branch as is.
      log("resume mode: skipping fresh implementation, re-entering review/fix loop");
      lastResult = await runReviewFixLoop(ctx);
      phasesRun.push("review", "fix");
      if (!lastResult.ok)
        return failure(ctx, lastResult, runDir, logPath);
      lastResult = await runPreparePr(ctx);
      phasesRun.push("prepare-pr");
      if (!lastResult.ok)
        return failure(ctx, lastResult, runDir, logPath);
      lastResult = await runMergeCheck(ctx);
      phasesRun.push("merge-check");
      return finalize(ctx, lastResult, runDir, logPath, phasesRun);
    }

    switch (phase) {
      case "implement":
        lastResult = await runImplement(ctx);
        phasesRun.push("implement");
        break;
      case "review":
        lastResult = await runReview(ctx);
        phasesRun.push("review");
        break;
      case "review-ui":
        lastResult = await runReviewUi(ctx);
        phasesRun.push("review-ui");
        break;
      case "fix": {
        const review = await runReview(ctx);
        phasesRun.push("review");
        if (review.rateLimited) {
          lastResult = review;
          break;
        }
        if (reviewIsClean(review.output)) {
          ctx.log("no findings to fix.");
          lastResult = { ok: true, output: review.output };
        } else {
          lastResult = await runFix(ctx, review.output);
          phasesRun.push("fix");
        }
        break;
      }
      case "prepare-pr":
        lastResult = await runPreparePr(ctx);
        phasesRun.push("prepare-pr");
        break;
      case "e2e-verify":
        lastResult = await runE2eVerify(ctx);
        phasesRun.push("e2e-verify");
        break;
      case "merge-check":
        lastResult = await runMergeCheck(ctx);
        phasesRun.push("merge-check");
        break;
      case "all": {
        lastResult = await runImplement(ctx);
        phasesRun.push("implement");
        if (lastResult.rateLimited) break;
        lastResult = await runReviewFixLoop(ctx);
        phasesRun.push("review", "fix");
        if (!lastResult.ok) break;
        if (
          !(await hasUncommittedChanges(options.repoRoot)) &&
          !(await hasDiffAgainstBase(options.repoRoot, ctx.baseBranch))
        ) {
          lastResult = {
            ok: false,
            output: `no changes detected for ${ctx.planId} after implementation`,
          };
          break;
        }
        if (await hasUncommittedChanges(options.repoRoot)) {
          await commitAll(options.repoRoot, ctx.planTitle);
        }
        lastResult = await runPreparePr(ctx);
        phasesRun.push("prepare-pr");
        if (!lastResult.ok) break;
        lastResult = await runMergeCheck(ctx);
        phasesRun.push("merge-check");
        break;
      }
    }

    return finalize(ctx, lastResult, runDir, logPath, phasesRun);
  } catch (err) {
    log(`runner error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      planId: planResolution.planId,
      branch,
      runDir,
      logPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function failure(
  ctx: RunContext,
  result: { output: string; rateLimited?: boolean },
  runDir: string,
  logPath: string,
): RunTaskOutcome {
  return {
    ok: false,
    planId: ctx.planId,
    branch: ctx.branch,
    runDir,
    logPath,
    reason: result.output,
    ...(result.rateLimited ? { rateLimited: true } : {}),
  };
}

function finalize(
  ctx: RunContext,
  lastResult: { ok: boolean; output: string; rateLimited?: boolean },
  runDir: string,
  logPath: string,
  phasesRun: Phase[],
): RunTaskOutcome {
  const tokensTotal = ctx.tokensUsed.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  if (!lastResult.ok) {
    return {
      ok: false,
      planId: ctx.planId,
      branch: ctx.branch,
      runDir,
      logPath,
      reason: lastResult.output,
      ...(lastResult.rateLimited ? { rateLimited: true } : {}),
    };
  }
  return {
    ok: true,
    planId: ctx.planId,
    branch: ctx.branch,
    runDir,
    logPath,
    phasesRun,
    tokensTotal,
  };
}

interface PlanResolution {
  planId: string;
  planSlug: string;
  planPath: string;
  planTitle: string;
  planPhase: string;
}

function resolvePlan(planDir: string, taskRef: string): PlanResolution {
  // taskRef can be a path to a plan file, or a numeric prefix that
  // matches a single plan in planDir.
  let planPath: string;
  if (existsSync(taskRef) && statSync(taskRef).isFile()) {
    planPath = path.resolve(taskRef);
  } else {
    if (!existsSync(planDir)) {
      throw new Error(`plan dir not found: ${planDir}`);
    }
    const matches = readdirSync(planDir)
      .filter((f) => f.startsWith(`${taskRef}-`) && f.endsWith(".md"))
      .sort();
    if (matches.length === 0) {
      throw new Error(`could not resolve plan for task ref: ${taskRef}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `task ref ${taskRef} matches multiple plans: ${matches.join(", ")}`,
      );
    }
    planPath = path.join(planDir, matches[0]!);
  }
  const taskFile = path.basename(planPath);
  const idMatch = /^(\d{4})/.exec(taskFile);
  if (!idMatch) {
    throw new Error(`plan filename must start with a 4-digit id: ${taskFile}`);
  }
  const planId = idMatch[1]!;
  const slug = taskFile.replace(/\.md$/, "");
  const planSlug = slug;
  const body = readFileSync(planPath, "utf8");
  const titleMatch = body.split(/\r?\n/).find((l) => l.startsWith("# "));
  const planTitle = titleMatch ? titleMatch.replace(/^# /, "").trim() : planId;
  // Extract `phase:` from frontmatter for context-section scoping.
  let planPhase = "";
  const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(body);
  if (fmMatch) {
    const phaseLine = fmMatch[1]!
      .split(/\r?\n/)
      .find((l) => l.startsWith("phase:"));
    if (phaseLine) {
      planPhase = phaseLine
        .replace(/^phase:\s*/, "")
        .replace(/^"|"$/g, "")
        .trim();
    }
  }
  return { planId, planSlug, planPath, planTitle, planPhase };
}

function makeRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "-",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
}
