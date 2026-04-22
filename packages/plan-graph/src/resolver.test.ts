import { describe, expect, it } from "vitest";

import {
  computeBlocks,
  nextEligiblePlans,
  planStatus,
  topologicalOrder,
  unmetDependencies,
} from "./resolver.ts";
import type { PlanStatus } from "./schema.ts";
import type { Plan } from "./types.ts";

function makePlan(
  id: string,
  dependsOn: string[] = [],
  status: PlanStatus = "active",
  location: Plan["location"] = "active",
): Plan {
  return {
    id,
    title: `Plan ${id}`,
    phase: "Test",
    status,
    dependsOn: [...dependsOn].sort(),
    estimatedPasses: 1,
    acceptanceTags: [],
    location,
    filePath: `/tmp/${id}.md`,
    body: "",
    raw: {
      id,
      title: `Plan ${id}`,
      phase: "Test",
      status,
      depends_on: dependsOn,
      estimated_passes: 1,
      acceptance_tags: [],
    },
  };
}

describe("computeBlocks", () => {
  it("inverts the depends_on edges", () => {
    const plans = [
      makePlan("0001"),
      makePlan("0002", ["0001"]),
      makePlan("0003", ["0001", "0002"]),
    ];
    const blocks = computeBlocks(plans);
    expect(blocks.get("0001")).toEqual(["0002", "0003"]);
    expect(blocks.get("0002")).toEqual(["0003"]);
    expect(blocks.get("0003")).toEqual([]);
  });
});

describe("nextEligiblePlans", () => {
  it("returns active plans with all deps completed", () => {
    const plans = [
      makePlan("0001", [], "completed", "completed"),
      makePlan("0002", ["0001"], "active"),
      makePlan("0003", ["0002"], "active"),
      makePlan("0004", ["0001"], "blocked"),
    ];
    const eligible = nextEligiblePlans(plans).map((p) => p.id);
    expect(eligible).toEqual(["0002"]);
  });

  it("excludes in_progress plans", () => {
    const plans = [
      makePlan("0001", [], "completed", "completed"),
      makePlan("0002", ["0001"], "in_progress"),
    ];
    expect(nextEligiblePlans(plans)).toEqual([]);
  });

  it("returns plans with no deps when none are completed yet", () => {
    const plans = [makePlan("0001"), makePlan("0002", ["0001"])];
    expect(nextEligiblePlans(plans).map((p) => p.id)).toEqual(["0001"]);
  });
});

describe("unmetDependencies", () => {
  it("lists deps that are not completed", () => {
    const plans = [
      makePlan("0001", [], "completed", "completed"),
      makePlan("0002", [], "active"),
      makePlan("0003", ["0001", "0002"], "active"),
    ];
    expect(unmetDependencies(plans[2]!, plans)).toEqual(["0002"]);
  });
});

describe("planStatus", () => {
  it("returns null for unknown id", () => {
    expect(planStatus([makePlan("0001")], "0099")).toBeNull();
  });

  it("reports blocks and eligibility", () => {
    const plans = [
      makePlan("0001", [], "completed", "completed"),
      makePlan("0002", ["0001"], "active"),
      makePlan("0003", ["0001"], "active"),
    ];
    const report = planStatus(plans, "0001");
    expect(report?.blocks).toEqual(["0002", "0003"]);
    expect(report?.eligible).toBe(false); // already completed
    const report2 = planStatus(plans, "0002");
    expect(report2?.eligible).toBe(true);
    expect(report2?.unmetDependencies).toEqual([]);
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies before dependents", () => {
    const plans = [
      makePlan("0003", ["0002"]),
      makePlan("0002", ["0001"]),
      makePlan("0001"),
    ];
    expect(topologicalOrder(plans).map((p) => p.id)).toEqual([
      "0001",
      "0002",
      "0003",
    ]);
  });

  it("ties break by id ascending", () => {
    const plans = [makePlan("0001"), makePlan("0002"), makePlan("0003")];
    expect(topologicalOrder(plans).map((p) => p.id)).toEqual([
      "0001",
      "0002",
      "0003",
    ]);
  });

  it("is stable across diamond shape", () => {
    const plans = [
      makePlan("0001"),
      makePlan("0002", ["0001"]),
      makePlan("0003", ["0001"]),
      makePlan("0004", ["0002", "0003"]),
    ];
    expect(topologicalOrder(plans).map((p) => p.id)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
    ]);
  });
});
