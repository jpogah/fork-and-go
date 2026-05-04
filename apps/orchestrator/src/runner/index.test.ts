import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HarnessConfigSchema, type HarnessConfig } from "@harness/config";
import type { AgentResult, AgentRunner } from "@harness/agent-runner";

import { runTask } from "./index.ts";
import { execCmd } from "./git.ts";

function buildConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return HarnessConfigSchema.parse({
    agent: { provider: "claude", maxReviewPasses: 2 },
    ...overrides,
  });
}

function buildResult(message: string): AgentResult {
  return {
    message,
    tokensUsed: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 1,
    },
    ok: true,
  };
}

async function makeFixtureRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-runner-"));
  await execCmd("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execCmd("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execCmd("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
  await execCmd("git", ["add", "."], { cwd: dir });
  await execCmd("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function writePlan(
  repoRoot: string,
  id: string,
  title: string,
): Promise<void> {
  const planDir = path.join(repoRoot, "docs", "exec-plans", "active");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    path.join(planDir, `${id}-trivial.md`),
    [
      "---",
      `id: "${id}"`,
      `title: "${title}"`,
      'phase: "Harness"',
      'status: "active"',
      "depends_on: []",
      "estimated_passes: 1",
      "acceptance_tags: []",
      "---",
      "",
      `# ${id} ${title}`,
      "",
      "## Goal",
      "Trivial fixture.",
      "",
      "## Implement",
      "Do nothing.",
      "",
      "## Review",
      "No-op.",
      "",
    ].join("\n"),
  );
  // Commit the plan file so the working tree stays clean for branch ops.
  await execCmd("git", ["add", "."], { cwd: repoRoot });
  await execCmd("git", ["commit", "-q", "-m", `add ${id}`], { cwd: repoRoot });
}

describe("runTask", () => {
  it("runs the implement phase against a fixture repo with a stub runner", async () => {
    const repoRoot = await makeFixtureRepo();
    try {
      await writePlan(repoRoot, "0001", "Trivial");
      const exec = vi.fn(async () => buildResult("did the thing"));
      const review = vi.fn(async () => buildResult("No findings."));
      const complete = vi.fn(async () => buildResult(""));
      const runner: AgentRunner = { exec, review, complete };

      const outcome = await runTask({
        taskRef: "0001",
        repoRoot,
        config: buildConfig(),
        phase: "implement",
        agentRunner: runner,
        localOnly: true,
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.planId).toBe("0001");
        expect(outcome.branch).toBe("task/0001-trivial");
        expect(outcome.phasesRun).toEqual(["implement"]);
        expect(outcome.tokensTotal.inputTokens).toBe(100);
      }
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs the fix phase: review clean → no fix invocation", async () => {
    const repoRoot = await makeFixtureRepo();
    try {
      await writePlan(repoRoot, "0002", "Already Clean");
      const exec = vi.fn(async () => buildResult("should not be called"));
      const review = vi.fn(async () => buildResult("No findings."));
      const complete = vi.fn(async () => buildResult(""));
      const runner: AgentRunner = { exec, review, complete };

      const outcome = await runTask({
        taskRef: "0002",
        repoRoot,
        config: buildConfig(),
        phase: "fix",
        agentRunner: runner,
        localOnly: true,
      });

      expect(outcome.ok).toBe(true);
      expect(review).toHaveBeenCalledTimes(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to start when .orchestrator/FROZEN exists", async () => {
    const repoRoot = await makeFixtureRepo();
    try {
      await writePlan(repoRoot, "0003", "Frozen");
      mkdirSync(path.join(repoRoot, ".orchestrator"), { recursive: true });
      writeFileSync(
        path.join(repoRoot, ".orchestrator", "FROZEN"),
        "operator note",
      );
      const exec = vi.fn();
      const review = vi.fn();
      const complete = vi.fn();
      const runner = { exec, review, complete } as unknown as AgentRunner;

      const outcome = await runTask({
        taskRef: "0003",
        repoRoot,
        config: buildConfig(),
        phase: "implement",
        agentRunner: runner,
        localOnly: true,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("frozen");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("propagates rateLimitHit from the runner as outcome.rateLimited", async () => {
    const repoRoot = await makeFixtureRepo();
    try {
      await writePlan(repoRoot, "0004", "Rate Limited");
      const limitedResult: AgentResult = {
        message: "ran out of capacity",
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
      const exec = vi.fn(async () => limitedResult);
      const review = vi.fn();
      const complete = vi.fn();
      const runner: AgentRunner = { exec, review, complete };

      const outcome = await runTask({
        taskRef: "0004",
        repoRoot,
        config: buildConfig(),
        phase: "implement",
        agentRunner: runner,
        localOnly: true,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.rateLimited).toBe(true);
        expect(outcome.reason).toContain("ran out of capacity");
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
