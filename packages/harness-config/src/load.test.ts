import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessConfigError, loadHarnessConfig } from "./load.ts";

describe("loadHarnessConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a JSON config and applies defaults", async () => {
    writeFileSync(
      path.join(dir, "harness.config.json"),
      JSON.stringify({ agent: { provider: "claude" } }),
    );
    const config = await loadHarnessConfig(dir, { env: {} });
    expect(config.agent.provider).toBe("claude");
    expect(config.planDir).toBe("docs/exec-plans/active");
    expect(config.completedDir).toBe("docs/exec-plans/completed");
    expect(config.baseBranch).toBe("main");
    expect(config.agent.maxReviewPasses).toBe(5);
  });

  it("env vars override file fields", async () => {
    writeFileSync(
      path.join(dir, "harness.config.json"),
      JSON.stringify({
        agent: { provider: "claude" },
        baseBranch: "main",
      }),
    );
    const config = await loadHarnessConfig(dir, {
      env: {
        HARNESS_AGENT_PROVIDER: "codex",
        HARNESS_BASE_BRANCH: "develop",
        HARNESS_PLAN_DIR: "tasks/active",
      },
    });
    expect(config.agent.provider).toBe("codex");
    expect(config.baseBranch).toBe("develop");
    expect(config.planDir).toBe("tasks/active");
  });

  it("rejects an unknown agent provider", async () => {
    writeFileSync(
      path.join(dir, "harness.config.json"),
      JSON.stringify({ agent: { provider: "gpt-9" } }),
    );
    await expect(loadHarnessConfig(dir, { env: {} })).rejects.toThrow(
      HarnessConfigError,
    );
  });

  it("requires the agent block", async () => {
    writeFileSync(
      path.join(dir, "harness.config.json"),
      JSON.stringify({ baseBranch: "main" }),
    );
    await expect(loadHarnessConfig(dir, { env: {} })).rejects.toThrow(
      /agent/,
    );
  });

  it("works with no file when env supplies the agent provider", async () => {
    const config = await loadHarnessConfig(dir, {
      env: { HARNESS_AGENT_PROVIDER: "claude" },
    });
    expect(config.agent.provider).toBe("claude");
  });
});
