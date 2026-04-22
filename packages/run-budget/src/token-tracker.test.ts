import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregateRecords,
  parseTokensUsedFile,
  scanPlanRuns,
  TOKENS_USED_FILENAME,
} from "./token-tracker.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "run-budget-tracker-"));
}

describe("parseTokensUsedFile", () => {
  it("parses valid NDJSON records", () => {
    const dir = freshDir();
    const file = path.join(dir, TOKENS_USED_FILENAME);
    writeFileSync(
      file,
      [
        JSON.stringify({
          phase: "implement",
          model: "claude-opus",
          inputTokens: 100,
          outputTokens: 50,
        }),
        JSON.stringify({
          phase: "review",
          model: "claude-sonnet",
          inputTokens: 200,
          outputTokens: 80,
        }),
        "",
      ].join("\n"),
    );
    const records = parseTokensUsedFile(file);
    expect(records).toHaveLength(2);
    expect(records[0]?.phase).toBe("implement");
    expect(records[1]?.outputTokens).toBe(80);
  });

  it("skips malformed lines without throwing", () => {
    const dir = freshDir();
    const file = path.join(dir, TOKENS_USED_FILENAME);
    writeFileSync(
      file,
      [
        "not json",
        JSON.stringify({ phase: "implement" }), // missing tokens
        JSON.stringify({
          phase: "review",
          model: "x",
          inputTokens: 10,
          outputTokens: 5,
        }),
      ].join("\n"),
    );
    const records = parseTokensUsedFile(file);
    expect(records).toHaveLength(1);
  });

  it("returns [] for a missing file", () => {
    expect(parseTokensUsedFile(path.join(freshDir(), "missing"))).toEqual([]);
  });
});

describe("aggregateRecords", () => {
  it("sums tokens and derives cost from the rate card when costCents is absent", () => {
    const usage = aggregateRecords([
      {
        phase: "implement",
        model: "claude-opus",
        inputTokens: 1_000_000,
        outputTokens: 200_000,
      },
    ]);
    expect(usage.totalTokens).toBe(1_200_000);
    expect(usage.costCents).toBeCloseTo(3000, 0);
    expect(usage.byModel["claude-opus"]).toBe(1_200_000);
    expect(usage.byPhase.implement).toBe(1_200_000);
  });

  it("respects an explicit costCents override", () => {
    const usage = aggregateRecords([
      {
        phase: "implement",
        model: "claude-opus",
        inputTokens: 100,
        outputTokens: 50,
        costCents: 42,
      },
    ]);
    expect(usage.costCents).toBeCloseTo(42, 2);
  });
});

describe("scanPlanRuns", () => {
  it("walks every run directory and skips consumed files", () => {
    const root = freshDir();
    const planDir = path.join(root, "0052");
    const runA = path.join(planDir, "20260422-100000");
    const runB = path.join(planDir, "20260422-110000");
    mkdirSync(runA, { recursive: true });
    mkdirSync(runB, { recursive: true });
    writeFileSync(
      path.join(runA, TOKENS_USED_FILENAME),
      JSON.stringify({
        phase: "implement",
        model: "claude-opus",
        inputTokens: 100,
        outputTokens: 50,
      }) + "\n",
    );
    writeFileSync(
      path.join(runB, TOKENS_USED_FILENAME),
      JSON.stringify({
        phase: "implement",
        model: "claude-opus",
        inputTokens: 200,
        outputTokens: 100,
      }) + "\n",
    );

    const firstPass = scanPlanRuns({
      taskRunsDir: root,
      planId: "0052",
    });
    expect(firstPass.usage.totalTokens).toBe(450);
    expect(firstPass.consumedIds).toHaveLength(2);
    // IDs are namespaced by plan so a single shared `consumed` set across
    // plans never collides.
    expect(firstPass.consumedIds[0]).toMatch(
      /^0052\/\d{8}-\d{6}\/tokens-used\.json$/,
    );

    // Re-scan with the first batch marked consumed — should see zero.
    const secondPass = scanPlanRuns({
      taskRunsDir: root,
      planId: "0052",
      consumed: new Set(firstPass.consumedIds),
    });
    expect(secondPass.usage.totalTokens).toBe(0);
    expect(secondPass.consumedIds).toHaveLength(0);
  });

  it("returns empty usage when the plan has no runs", () => {
    const root = freshDir();
    const result = scanPlanRuns({ taskRunsDir: root, planId: "0099" });
    expect(result.usage.totalTokens).toBe(0);
    expect(result.consumedIds).toHaveLength(0);
  });

  it("ignores non-run directories like `latest` symlinks", () => {
    const root = freshDir();
    const planDir = path.join(root, "0052");
    mkdirSync(path.join(planDir, "latest"), { recursive: true });
    mkdirSync(path.join(planDir, "not-a-run"), { recursive: true });
    writeFileSync(
      path.join(planDir, "latest", TOKENS_USED_FILENAME),
      JSON.stringify({
        phase: "x",
        model: "y",
        inputTokens: 999,
        outputTokens: 999,
      }) + "\n",
    );
    const result = scanPlanRuns({ taskRunsDir: root, planId: "0052" });
    expect(result.usage.totalTokens).toBe(0);
  });
});
