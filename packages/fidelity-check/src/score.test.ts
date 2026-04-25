import { describe, expect, it } from "vitest";

import { computeDrift, DEFAULT_THRESHOLD, exceedsThreshold } from "./score.ts";
import type { AuditOutput } from "./schemas.ts";

function output(
  overrides: Partial<AuditOutput> & { riskScore?: number } = {},
): AuditOutput {
  return {
    risk_score: overrides.riskScore ?? overrides.risk_score ?? 0,
    requirements: overrides.requirements ?? [],
    drift: overrides.drift ?? [],
    risks: overrides.risks ?? [],
    recommended_actions: overrides.recommended_actions ?? [],
  };
}

describe("computeDrift", () => {
  it("returns zero for an empty audit", () => {
    const c = computeDrift(output());
    expect(c.score).toBe(0);
    expect(c.totalRequirements).toBe(0);
    expect(c.unmetPct).toBe(0);
  });

  it("matches the formula for a clean audit", () => {
    // 4 requirements, all met. riskScore=10. No drift.
    // unmetPct = 0; driftComponent = 0; riskComponent = 3. Score rounds to 3.
    const c = computeDrift(
      output({
        risk_score: 10,
        requirements: [
          { requirement: "r1", status: "met", notes: "" },
          { requirement: "r2", status: "met", notes: "" },
          { requirement: "r3", status: "met", notes: "" },
          { requirement: "r4", status: "met", notes: "" },
        ],
      }),
    );
    expect(c.metCount).toBe(4);
    expect(c.unmetPct).toBe(0);
    expect(c.score).toBe(3);
  });

  it("weights partials at half of unmet", () => {
    // 4 requirements: 2 met, 2 partial. unmet component counts 1 effective.
    // unmetPct = 25. unmetComponent = 12.5. riskScore 0. driftCount 0.
    // score rounds from 12.5 to 13.
    const c = computeDrift(
      output({
        requirements: [
          { requirement: "r1", status: "met", notes: "" },
          { requirement: "r2", status: "met", notes: "" },
          { requirement: "r3", status: "partial", notes: "" },
          { requirement: "r4", status: "partial", notes: "" },
        ],
      }),
    );
    expect(c.partialCount).toBe(2);
    expect(c.unmetPct).toBe(25);
    expect(c.score).toBe(13);
  });

  it("applies the drift-count * 2 weight", () => {
    const c = computeDrift(
      output({
        requirements: [{ requirement: "r1", status: "met", notes: "" }],
        drift: [
          { plan_id: "0100", title: "A", rationale: "extra" },
          { plan_id: "0101", title: "B", rationale: "extra" },
          { plan_id: "0102", title: "C", rationale: "extra" },
        ],
      }),
    );
    // unmetPct = 0. drift = 3 * 2 = 6. risk = 0. Total 6.
    expect(c.driftCount).toBe(3);
    expect(c.score).toBe(6);
  });

  it("combines components exactly at the threshold edge", () => {
    // Target drift score 25 exactly:
    //   unmetPct = 40 (2/5 unmet) -> 0.5 * 40 = 20
    //   driftCount = 1            -> 2
    //   riskScore = 10            -> 3
    // total = 25
    const c = computeDrift(
      output({
        risk_score: 10,
        requirements: [
          { requirement: "r1", status: "met", notes: "" },
          { requirement: "r2", status: "met", notes: "" },
          { requirement: "r3", status: "met", notes: "" },
          { requirement: "r4", status: "unmet", notes: "" },
          { requirement: "r5", status: "unmet", notes: "" },
        ],
        drift: [{ plan_id: "0100", title: "D", rationale: "extra" }],
      }),
    );
    expect(c.score).toBe(25);
    expect(exceedsThreshold(c.score, DEFAULT_THRESHOLD)).toBe(false);
    expect(exceedsThreshold(c.score, 24)).toBe(true);
  });

  it("clamps to 100", () => {
    const c = computeDrift(
      output({
        risk_score: 100,
        requirements: [
          { requirement: "r1", status: "unmet", notes: "" },
          { requirement: "r2", status: "unmet", notes: "" },
        ],
        drift: Array.from({ length: 50 }).map((_, i) => ({
          plan_id: String(9000 + i).padStart(4, "0"),
          title: `D${i}`,
          rationale: "extra",
        })),
      }),
    );
    expect(c.score).toBe(100);
  });
});
