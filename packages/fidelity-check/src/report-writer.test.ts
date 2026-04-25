import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FidelityContext } from "./context-builder.ts";
import { writeReport } from "./report-writer.ts";
import { computeDrift } from "./score.ts";
import type { AuditOutput } from "./schemas.ts";

function ctx(): FidelityContext {
  return {
    spec: {
      path: "/virtual/docs/product-specs/demo.md",
      slug: "demo",
      content: "# Demo",
    },
    plans: [],
    repoSlice: {
      appFiles: [],
      packageFiles: [],
      apiRoutes: [],
      testFiles: [],
    },
    previousSummary: null,
    repoRoot: "/virtual",
  };
}

function audit(): AuditOutput {
  return {
    risk_score: 10,
    requirements: [
      {
        requirement: "R1",
        status: "met",
        plan_id: "0010",
        notes: "",
      },
      {
        requirement: "R2",
        status: "unmet",
        notes: "missing",
      },
    ],
    drift: [{ plan_id: "0100", title: "Extra", rationale: "unasked feature" }],
    risks: [{ level: "medium", category: "unmet", detail: "launch risk" }],
    recommended_actions: ["Add a plan."],
  };
}

describe("writeReport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fidelity-report-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a markdown + JSON summary pair", () => {
    const a = audit();
    const c = computeDrift(a);
    const now = new Date("2026-04-22T10:00:00Z");
    const result = writeReport(ctx(), a, c, {
      reportsDir: dir,
      specSlug: "demo",
      now,
      threshold: 25,
    });
    expect(result.skipped).toBe(false);
    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.summaryPath)).toBe(true);
    expect(path.basename(result.markdownPath)).toBe("2026-04-22-demo.md");
    expect(path.basename(result.summaryPath)).toBe("2026-04-22-demo.json");

    const md = readFileSync(result.markdownPath, "utf8");
    expect(md).toContain("Spec Fidelity Report");
    expect(md).toContain("Drift Score:");
    // Unmet requirement shows up with the ❌ marker.
    expect(md).toContain("❌");
    // Drift section includes the plan id.
    expect(md).toContain("0100");

    const summary = JSON.parse(readFileSync(result.summaryPath, "utf8"));
    expect(summary.score).toBe(c.score);
    expect(summary.specSlug).toBe("demo");
    expect(summary.unmet).toEqual([{ requirement: "R2", notes: "missing" }]);
  });

  it("skips writing when the previous summary is structurally identical", () => {
    const a = audit();
    const c = computeDrift(a);
    const now = new Date("2026-04-22T10:00:00Z");

    // First write establishes the baseline.
    const first = writeReport(ctx(), a, c, {
      reportsDir: dir,
      specSlug: "demo",
      now,
      threshold: 25,
    });
    expect(first.skipped).toBe(false);

    // Second run with the same inputs; pass the prior summary path so the
    // dedup check fires.
    const second = writeReport(ctx(), a, c, {
      reportsDir: dir,
      specSlug: "demo",
      now: new Date("2026-04-23T10:00:00Z"),
      threshold: 25,
      previousSummaryPath: first.summaryPath,
    });
    expect(second.skipped).toBe(true);
    // The new-day-named summary was NOT written.
    expect(existsSync(path.join(dir, "2026-04-23-demo.json"))).toBe(false);
    // Skipped result points back at the previous run's on-disk files so
    // downstream consumers (e.g. meta-plan links) don't reference ghosts.
    expect(second.summaryPath).toBe(first.summaryPath);
    expect(second.markdownPath).toBe(first.markdownPath);
  });

  it("rewrites when the previous summary differs", () => {
    const now = new Date("2026-04-22T10:00:00Z");
    const first = writeReport(ctx(), audit(), computeDrift(audit()), {
      reportsDir: dir,
      specSlug: "demo",
      now,
      threshold: 25,
    });

    // Different audit: extra drift item changes the score.
    const a2 = audit();
    a2.drift.push({ plan_id: "0101", title: "B", rationale: "another" });
    const c2 = computeDrift(a2);
    const second = writeReport(ctx(), a2, c2, {
      reportsDir: dir,
      specSlug: "demo",
      now: new Date("2026-04-23T10:00:00Z"),
      threshold: 25,
      previousSummaryPath: first.summaryPath,
    });
    expect(second.skipped).toBe(false);
    expect(existsSync(path.join(dir, "2026-04-23-demo.json"))).toBe(true);
  });

  it("marks the report OVER threshold when the score exceeds it", () => {
    const a: AuditOutput = {
      risk_score: 100,
      requirements: [{ requirement: "R1", status: "unmet", notes: "" }],
      drift: [
        { plan_id: "0100", title: "A", rationale: "x" },
        { plan_id: "0101", title: "B", rationale: "x" },
        { plan_id: "0102", title: "C", rationale: "x" },
      ],
      risks: [],
      recommended_actions: [],
    };
    const c = computeDrift(a);
    const result = writeReport(ctx(), a, c, {
      reportsDir: dir,
      specSlug: "demo",
      now: new Date("2026-04-22T10:00:00Z"),
      threshold: 25,
    });
    const md = readFileSync(result.markdownPath, "utf8");
    expect(md).toContain("OVER");
    const summary = JSON.parse(readFileSync(result.summaryPath, "utf8"));
    expect(summary.exceedsThreshold).toBe(true);
  });
});
