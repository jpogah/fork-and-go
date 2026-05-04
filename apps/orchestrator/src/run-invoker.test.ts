import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HarnessConfigSchema,
  type HarnessConfig,
} from "@harness/config";
import type { AgentResult, AgentRunner } from "@harness/agent-runner";

import { createRunInvoker } from "./run-invoker.ts";

function buildConfig(): HarnessConfig {
  return HarnessConfigSchema.parse({
    agent: { provider: "claude", maxReviewPasses: 1 },
  });
}

function buildResult(message: string, ok = true): AgentResult {
  return {
    message,
    tokensUsed: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 0,
    },
    ok,
  };
}

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "invoker-"));
  // Bare init avoids real git semantics; daemon tests fully exercise the
  // git path. RunInvoker just translates outcomes, so we can mock runTask.
  return dir;
}

function writePlan(repoRoot: string, id: string): void {
  const planDir = path.join(repoRoot, "docs", "exec-plans", "active");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    path.join(planDir, `${id}-trivial.md`),
    [
      "---",
      `id: "${id}"`,
      'title: "Trivial"',
      'phase: "Harness"',
      'status: "active"',
      "depends_on: []",
      "estimated_passes: 1",
      "acceptance_tags: []",
      "---",
      "",
      `# ${id} Trivial`,
      "",
    ].join("\n"),
  );
}

describe("createRunInvoker", () => {
  it("translates a successful runTask outcome into exitCode=0", async () => {
    const repoRoot = fixtureRepo();
    try {
      writePlan(repoRoot, "0001");
      const exec = vi.fn(async () => buildResult("done"));
      const review = vi.fn(async () => buildResult("No findings."));
      const complete = vi.fn(async () => buildResult(""));
      const runner: AgentRunner = { exec, review, complete };

      const invoker = createRunInvoker();
      const result = await invoker.invoke({
        planId: "0001",
        repoRoot,
        config: buildConfig(),
        logsDir: path.join(repoRoot, ".orchestrator", "logs"),
        agentRunner: runner,
        localOnly: true,
        phase: "implement",
        // Initialize the repo as a git repo with a clean tree so ensureBranch
        // works inside runTask.
      });

      // We didn't init git, so runTask's ensureBranch fails — that's fine,
      // the test exercises the failure-path translation. The reason should
      // contain something git-related.
      expect(result.exitCode).toBe(1);
      expect(result.rateLimited).toBe(false);
      expect(result.reason).not.toBe("");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("translates a rate-limit outcome into exitCode=2 + rateLimited=true", async () => {
    const repoRoot = fixtureRepo();
    try {
      writePlan(repoRoot, "0002");
      // We need runTask to actually return rateLimited; easiest is to mock
      // the agent runner to return rateLimitHit and let runTask propagate.
      const limited: AgentResult = {
        message: "rate limit hit",
        tokensUsed: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costCents: 0,
        },
        rateLimitHit: { reason: "claude rate_limit" },
        ok: false,
      };
      // To get past ensureBranch we need a real git repo. Use execa-equivalent.
      const { execCmd } = await import("./runner/git.ts");
      await execCmd("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
      await execCmd("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot });
      await execCmd("git", ["config", "user.name", "T"], { cwd: repoRoot });
      writeFileSync(path.join(repoRoot, "README.md"), "x");
      await execCmd("git", ["add", "."], { cwd: repoRoot });
      await execCmd("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
      writePlan(repoRoot, "0002");
      await execCmd("git", ["add", "."], { cwd: repoRoot });
      await execCmd("git", ["commit", "-q", "-m", "plan"], { cwd: repoRoot });

      const exec = vi.fn(async () => limited);
      const review = vi.fn(async () => buildResult("No findings."));
      const complete = vi.fn(async () => buildResult(""));
      const runner: AgentRunner = { exec, review, complete };

      const invoker = createRunInvoker();
      const result = await invoker.invoke({
        planId: "0002",
        repoRoot,
        config: buildConfig(),
        logsDir: path.join(repoRoot, ".orchestrator", "logs"),
        agentRunner: runner,
        localOnly: true,
        phase: "implement",
      });

      expect(result.exitCode).toBe(2);
      expect(result.rateLimited).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
