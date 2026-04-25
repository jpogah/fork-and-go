import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FidelitySummary } from "./report-writer.ts";
import { META_PLAN_FILENAME, suspendForFidelityReview } from "./suspend.ts";

function plan(opts: { id: string; status?: string; title?: string }): string {
  return [
    "---",
    `id: "${opts.id}"`,
    `title: "${opts.title ?? `Plan ${opts.id}`}"`,
    `phase: "Harness"`,
    `status: "${opts.status ?? "active"}"`,
    `depends_on: []`,
    `estimated_passes: 2`,
    `acceptance_tags: []`,
    "---",
    "",
    `# ${opts.id} Plan`,
    "",
    "Body",
    "",
  ].join("\n");
}

function summary(overrides: Partial<FidelitySummary> = {}): FidelitySummary {
  return {
    generatedAt: "2026-04-22T10:00:00Z",
    specSlug: "demo",
    specPath: "/virtual/demo.md",
    threshold: 25,
    exceedsThreshold: true,
    score: 42,
    totalRequirements: 5,
    metCount: 3,
    partialCount: 0,
    unmetCount: 2,
    driftCount: 1,
    riskScore: 40,
    breakdown: {
      unmetComponent: 20,
      driftComponent: 2,
      riskComponent: 12,
    },
    unmet: [
      { requirement: "Slack notifications", notes: "missing" },
      { requirement: "Cost roll-up", notes: "" },
    ],
    drift: [{ plan_id: "0100", title: "GPT swap", rationale: "extra" }],
    risks: [],
    ...overrides,
  };
}

describe("suspendForFidelityReview", () => {
  let root: string;
  let activeDir: string;
  let completedDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fidelity-suspend-"));
    activeDir = path.join(root, "active");
    completedDir = path.join(root, "completed");
    mkdirSync(activeDir);
    mkdirSync(completedDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks every active plan and writes the meta-plan", () => {
    writeFileSync(
      path.join(activeDir, "0010-a.md"),
      plan({ id: "0010" }),
      "utf8",
    );
    writeFileSync(
      path.join(activeDir, "0011-b.md"),
      plan({ id: "0011", status: "in_progress" }),
      "utf8",
    );
    writeFileSync(
      path.join(activeDir, "0012-c.md"),
      plan({ id: "0012", status: "blocked" }),
      "utf8",
    );
    writeFileSync(
      path.join(completedDir, "0005-done.md"),
      plan({ id: "0005", status: "completed" }),
      "utf8",
    );

    const result = suspendForFidelityReview({
      activeDir,
      completedDir,
      summary: summary(),
      reportMarkdownPath: "/reports/r.md",
      reportSummaryPath: "/reports/r.json",
      now: new Date("2026-04-22T10:00:00Z"),
    });

    expect(result.blockedPlanIds.sort()).toEqual(["0010", "0011"]);
    expect(result.metaPlanCreated).toBe(true);
    expect(existsSync(result.metaPlanPath)).toBe(true);
    expect(path.basename(result.metaPlanPath)).toBe(META_PLAN_FILENAME);

    const meta = readFileSync(result.metaPlanPath, "utf8");
    expect(meta).toContain('id: "9999"');
    expect(meta).toContain("Fidelity Review — demo");
    expect(meta).toContain("Slack notifications");

    const p10 = readFileSync(path.join(activeDir, "0010-a.md"), "utf8");
    expect(p10).toContain('status: "blocked"');
    const p11 = readFileSync(path.join(activeDir, "0011-b.md"), "utf8");
    expect(p11).toContain('status: "blocked"');
    // Already blocked stays blocked (no churn).
    const p12 = readFileSync(path.join(activeDir, "0012-c.md"), "utf8");
    expect(p12).toContain('status: "blocked"');
    // Completed plan is left alone.
    const p5 = readFileSync(path.join(completedDir, "0005-done.md"), "utf8");
    expect(p5).toContain('status: "completed"');
  });

  it("does not block itself (9999)", () => {
    writeFileSync(
      path.join(activeDir, "0010-a.md"),
      plan({ id: "0010" }),
      "utf8",
    );
    // Seed an existing meta-plan from a prior run.
    writeFileSync(
      path.join(activeDir, META_PLAN_FILENAME),
      plan({ id: "9999", title: "Fidelity Review — demo" }),
      "utf8",
    );
    const result = suspendForFidelityReview({
      activeDir,
      completedDir,
      summary: summary(),
      reportMarkdownPath: "/r.md",
      reportSummaryPath: "/r.json",
      now: new Date("2026-04-22T10:00:00Z"),
    });
    expect(result.blockedPlanIds).toEqual(["0010"]);
    expect(result.metaPlanCreated).toBe(false);
    expect(result.metaPlanUpdated).toBe(true);
    const meta = readFileSync(result.metaPlanPath, "utf8");
    // The meta-plan is rewritten to the latest summary — the id stays 9999
    // and the title reflects the spec slug.
    expect(meta).toContain('status: "active"');
    expect(meta).toContain("Fidelity Review");
  });
});
