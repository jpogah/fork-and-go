// Phase implementations. Each one drives the agent through a single
// concern and returns a typed outcome. They never call git/gh themselves
// for "ship" actions — that lives in the all-phase orchestration in
// index.ts.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { AgentResult } from "@harness/agent-runner";

import {
  e2eVerificationPassed,
  mergeIsReady,
  reviewIsClean,
} from "./sentinels.ts";
import {
  fixPrompt,
  implementationPrompt,
  mergeCheckPrompt,
  preparePrPrompt,
  reviewPrompt,
  reviewUiPrompt,
} from "./prompts.ts";
import {
  addAutomergeLabel,
  commitAll,
  createPr,
  editPr,
  execCmd,
  hasUncommittedChanges,
  pushBranch,
  reopenPr,
  viewCurrentPr,
} from "./git.ts";
import { startDevServer } from "./dev-server.ts";
import type { RunContext, TokensRecord } from "./types.ts";

export interface PhaseResult {
  ok: boolean;
  output: string;
  rateLimited?: boolean;
}

function recordTokens(
  ctx: RunContext,
  phase: string,
  result: AgentResult,
): void {
  const record: TokensRecord = {
    phase,
    model: "agent",
    inputTokens: result.tokensUsed.inputTokens,
    outputTokens: result.tokensUsed.outputTokens,
    at: new Date().toISOString(),
  };
  ctx.tokensUsed.push(record);
  const ndjson = JSON.stringify(record) + "\n";
  try {
    const tokensFile = path.join(ctx.runDir, "tokens-used.json");
    if (existsSync(tokensFile)) {
      writeFileSync(tokensFile, readFileSync(tokensFile, "utf8") + ndjson, "utf8");
    } else {
      writeFileSync(tokensFile, ndjson, "utf8");
    }
  } catch (err) {
    ctx.log(`tokens-used write failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function callAgent(
  ctx: RunContext,
  phase: string,
  mode: "exec" | "review",
  prompt: string,
): Promise<PhaseResult> {
  if (ctx.dryRun) {
    ctx.log(`DRY RUN: ${mode} for ${phase}`);
    return { ok: true, output: "" };
  }
  const fn = mode === "exec" ? ctx.runner.exec : ctx.runner.review;
  const result = await fn.call(ctx.runner, {
    prompt,
    cwd: ctx.repoRoot,
    onEvent: (e) => ctx.log(`[${phase}] ${e.kind}: ${e.text}`),
  });
  recordTokens(ctx, phase, result);
  if (result.rateLimitHit) {
    ctx.log(
      `[${phase}] rate limit reported by agent: ${result.rateLimitHit.reason}`,
    );
    return { ok: false, output: result.message, rateLimited: true };
  }
  return { ok: result.ok, output: result.message };
}

export async function runImplement(ctx: RunContext): Promise<PhaseResult> {
  ctx.log(`running implementation phase for ${ctx.planId}`);
  const prompt = implementationPrompt(ctx);
  const result = await callAgent(ctx, "implement", "exec", prompt);
  writeFileSync(path.join(ctx.runDir, "implement.out.md"), result.output, "utf8");
  return result;
}

export async function runReview(ctx: RunContext): Promise<PhaseResult> {
  ctx.log(`running self-review phase for ${ctx.planId}`);
  const prompt = reviewPrompt(ctx);
  const result = await callAgent(ctx, "review", "review", prompt);
  writeFileSync(path.join(ctx.runDir, "review.out.md"), result.output, "utf8");
  return result;
}

export async function runReviewUi(ctx: RunContext): Promise<PhaseResult> {
  ctx.log(`running review-ui phase for ${ctx.planId}`);
  const dev = await startDevServer({
    config: ctx.config,
    cwd: ctx.repoRoot,
    logDir: ctx.runDir,
    log: ctx.log,
  });
  try {
    const prompt = reviewUiPrompt(ctx, ctx.config.devServer!.url);
    const result = await callAgent(ctx, "review-ui", "review", prompt);
    writeFileSync(
      path.join(ctx.runDir, "review-ui.out.md"),
      result.output,
      "utf8",
    );
    return result;
  } finally {
    await dev.stop();
  }
}

export async function runFix(
  ctx: RunContext,
  findingsBody: string,
): Promise<PhaseResult> {
  ctx.log(`running fix phase for ${ctx.planId}`);
  const prompt = fixPrompt(ctx, findingsBody);
  const result = await callAgent(ctx, "fix", "exec", prompt);
  writeFileSync(path.join(ctx.runDir, "fix.out.md"), result.output, "utf8");
  return result;
}

export async function runReviewFixLoop(ctx: RunContext): Promise<PhaseResult> {
  for (let pass = 1; pass <= ctx.maxReviewPasses; pass += 1) {
    ctx.log(`review pass ${pass} of ${ctx.maxReviewPasses}`);
    const review = await runReview(ctx);
    if (review.rateLimited) return review;
    const findingsFile = path.join(ctx.runDir, `findings-pass-${pass}.md`);
    let findingsBody = "";

    if (!reviewIsClean(review.output)) {
      findingsBody = review.output;
      writeFileSync(findingsFile, findingsBody, "utf8");
      if (pass === ctx.maxReviewPasses) {
        return {
          ok: false,
          output: `review findings remain after ${ctx.maxReviewPasses} passes`,
        };
      }
      const fix = await runFix(ctx, findingsBody);
      if (fix.rateLimited) return fix;
      continue;
    }

    if (ctx.skipE2e) {
      ctx.log("review clean + skipE2e set; loop converged.");
      return { ok: true, output: review.output };
    }

    const e2e = await runE2eVerify(ctx);
    if (e2e.ok) {
      ctx.log("review clean + e2e clean; loop converged.");
      return { ok: true, output: review.output };
    }

    findingsBody =
      `## E2E Verification Findings (pass ${pass})\n\n` +
      `Playwright suite reported failures. Treat each failing test as Medium\n` +
      `or higher severity and address it in this fix pass.\n\n` +
      `--- e2e-verify.out.md ---\n\n` +
      e2e.output;
    writeFileSync(findingsFile, findingsBody, "utf8");
    if (pass === ctx.maxReviewPasses) {
      return {
        ok: false,
        output: `e2e findings remain after ${ctx.maxReviewPasses} passes`,
      };
    }
    const fix = await runFix(ctx, findingsBody);
    if (fix.rateLimited) return fix;
  }
  return {
    ok: false,
    output: `review/fix loop did not converge within ${ctx.maxReviewPasses} passes`,
  };
}

export async function runE2eVerify(ctx: RunContext): Promise<PhaseResult> {
  const sentinel = "E2E verification passed.";
  const summaryFile = path.join(ctx.runDir, "e2e-verify.out.md");
  const logFile = path.join(ctx.runDir, "e2e-verify.log");
  const outDir = path.join(ctx.runDir, "e2e-verify");
  mkdirSync(outDir, { recursive: true });

  if (ctx.dryRun) {
    ctx.log("DRY RUN: e2e-verify");
    writeFileSync(summaryFile, sentinel + "\n", "utf8");
    return { ok: true, output: sentinel };
  }

  const e2e = ctx.config.e2e;
  if (!e2e) {
    const body = [
      "E2E verification failed.",
      "",
      "Scaffold gap: harness.config.e2e.command is not set.",
      "",
      "The e2e-verify phase needs a configured command (e.g. `npm run e2e`)",
      "that runs a browser test suite. Add it to harness.config.{json,ts} or",
      "invoke with --skip-e2e for plans tagged as non-UI-touching.",
    ].join("\n");
    writeFileSync(summaryFile, body, "utf8");
    return { ok: false, output: body };
  }

  ctx.log(`running e2e: ${e2e.command}`);
  const result = await execCmd("sh", ["-c", e2e.command], { cwd: ctx.repoRoot });
  writeFileSync(logFile, result.stdout + "\n" + result.stderr, "utf8");

  for (const dir of e2e.artifactDirs) {
    const src = path.isAbsolute(dir) ? dir : path.join(ctx.repoRoot, dir);
    if (existsSync(src)) {
      const dest = path.join(outDir, path.basename(dir));
      try {
        await execCmd("rm", ["-rf", dest], { cwd: ctx.repoRoot });
        await execCmd("cp", ["-R", src, dest], { cwd: ctx.repoRoot });
      } catch {
        // best-effort artifact copy
      }
    }
  }

  if (result.exitCode === 0) {
    const body = `${sentinel}\n\nArtifacts: ${outDir}\n`;
    writeFileSync(summaryFile, body, "utf8");
    ctx.log("e2e verification passed");
    return { ok: true, output: body };
  }
  const tail = result.stdout.split("\n").slice(-80).join("\n");
  const body = [
    "E2E verification failed.",
    "",
    `Exit code: ${result.exitCode}`,
    `Full log: ${logFile}`,
    `Artifacts: ${outDir}`,
    "",
    "Last 80 lines of the log:",
    "```",
    tail,
    "```",
  ].join("\n");
  writeFileSync(summaryFile, body, "utf8");
  return { ok: e2eVerificationPassed(body), output: body };
}

export async function runPreparePr(ctx: RunContext): Promise<PhaseResult> {
  // Generate a seed body. We no longer call scripts/prepare_pr.sh; instead
  // the seed is a minimal scaffold and the agent fills it in.
  const seed = [
    "## Summary",
    "",
    "- TODO",
    "",
    "## Plan",
    "",
    `- ${ctx.planRel}`,
    "",
    "## Validation",
    "",
    "- [x] Self-review loop converged with no blocking findings",
    "",
    "## Risks",
    "",
    "- TODO",
    "",
    "## Follow-Ups",
    "",
    "- TODO",
  ].join("\n");
  const seedFile = path.join(ctx.runDir, "pr-seed.md");
  const bodyFile = path.join(ctx.runDir, "pr-body.md");
  writeFileSync(seedFile, seed, "utf8");

  ctx.log(`running prepare-pr phase for ${ctx.planId}`);
  const prompt = preparePrPrompt(ctx, seed);
  const result = await callAgent(ctx, "prepare-pr", "exec", prompt);
  writeFileSync(bodyFile, result.output, "utf8");
  if (result.rateLimited) return result;

  if (await hasUncommittedChanges(ctx.repoRoot)) {
    await commitAll(ctx.repoRoot, ctx.planTitle);
  }

  if (!ctx.localOnly) {
    await pushBranch(ctx.repoRoot, ctx.branch);
    const existing = await viewCurrentPr(ctx.repoRoot);
    if (existing) {
      if (existing.state === "CLOSED") {
        const reopened = await reopenPr(ctx.repoRoot, existing.number);
        if (reopened) {
          await editPr(ctx.repoRoot, existing.number, {
            title: ctx.planTitle,
            bodyFile,
          });
        } else {
          await createPr(ctx.repoRoot, {
            baseBranch: ctx.baseBranch,
            head: ctx.branch,
            title: ctx.planTitle,
            bodyFile,
          });
        }
      } else if (existing.state === "MERGED") {
        await createPr(ctx.repoRoot, {
          baseBranch: ctx.baseBranch,
          head: ctx.branch,
          title: ctx.planTitle,
          bodyFile,
        });
      } else {
        await editPr(ctx.repoRoot, existing.number, {
          title: ctx.planTitle,
          bodyFile,
        });
      }
    } else {
      await createPr(ctx.repoRoot, {
        baseBranch: ctx.baseBranch,
        head: ctx.branch,
        title: ctx.planTitle,
        bodyFile,
      });
    }
  }

  return { ok: true, output: result.output };
}

export async function runMergeCheck(ctx: RunContext): Promise<PhaseResult> {
  if (ctx.localOnly) {
    ctx.log("skipping merge-check in local-only mode");
    return { ok: true, output: "" };
  }
  const pr = await viewCurrentPr(ctx.repoRoot);
  if (!pr) {
    return { ok: false, output: "no PR found for current branch" };
  }
  if (!ctx.skipE2e) {
    const e2e = await runE2eVerify(ctx);
    if (!e2e.ok) {
      return {
        ok: false,
        output: `E2E verification failed; refusing merge-readiness review. See ${path.join(
          ctx.runDir,
          "e2e-verify.out.md",
        )}`,
      };
    }
  }
  const e2eRel = path.relative(ctx.repoRoot, path.join(ctx.runDir, "e2e-verify.out.md"));
  const prompt = mergeCheckPrompt(ctx, pr.number, e2eRel);
  const result = await callAgent(ctx, "merge-check", "review", prompt);
  writeFileSync(path.join(ctx.runDir, "merge.out.md"), result.output, "utf8");
  if (result.rateLimited) return result;
  if (mergeIsReady(result.output)) {
    ctx.log(`merge readiness green; labeling PR #${pr.number}`);
    await addAutomergeLabel(ctx.repoRoot, pr.number);
    return { ok: true, output: result.output };
  }
  return { ok: false, output: result.output };
}
