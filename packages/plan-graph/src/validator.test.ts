import { describe, expect, it } from "vitest";

import type { PlanStatus } from "./schema.ts";
import type { Plan } from "./types.ts";
import { formatIssue, validateGraph } from "./validator.ts";

function makePlan(
  id: string,
  opts: {
    dependsOn?: string[];
    status?: PlanStatus;
    location?: Plan["location"];
    filePath?: string;
  } = {},
): Plan {
  const status = opts.status ?? "active";
  const location =
    opts.location ?? (status === "completed" ? "completed" : "active");
  const filename = `${id}-name.md`;
  return {
    id,
    title: `Plan ${id}`,
    phase: "Test",
    status,
    dependsOn: [...(opts.dependsOn ?? [])].sort(),
    estimatedPasses: 1,
    acceptanceTags: [],
    location,
    filePath: opts.filePath ?? `/tmp/${location}/${filename}`,
    body: "",
    raw: {
      id,
      title: `Plan ${id}`,
      phase: "Test",
      status,
      depends_on: opts.dependsOn ?? [],
      estimated_passes: 1,
      acceptance_tags: [],
    },
  };
}

describe("validateGraph", () => {
  it("accepts a valid graph", () => {
    const plans = [
      makePlan("0001", { status: "completed" }),
      makePlan("0002", { dependsOn: ["0001"] }),
    ];
    expect(validateGraph(plans).ok).toBe(true);
  });

  it("detects duplicate ids", () => {
    const plans = [
      makePlan("0001", { filePath: "/tmp/active/0001-a.md" }),
      makePlan("0001", { filePath: "/tmp/active/0001-b.md" }),
    ];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.kind === "duplicate-id")).toBe(true);
    }
  });

  it("detects missing dependencies", () => {
    const plans = [makePlan("0002", { dependsOn: ["0001"] })];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.kind === "missing-dependency")).toBe(
        true,
      );
    }
  });

  it("detects self dependency", () => {
    const plans = [makePlan("0001", { dependsOn: ["0001"] })];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.kind === "self-dependency")).toBe(
        true,
      );
    }
  });

  it("detects cycles", () => {
    const plans = [
      makePlan("0001", { dependsOn: ["0003"] }),
      makePlan("0002", { dependsOn: ["0001"] }),
      makePlan("0003", { dependsOn: ["0002"] }),
    ];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.issues.find((i) => i.kind === "cycle");
      expect(cycle).toBeDefined();
      if (cycle && cycle.kind === "cycle") {
        expect(cycle.path[0]).toBe(cycle.path[cycle.path.length - 1]);
        expect(cycle.path.length).toBeGreaterThan(2);
      }
    }
  });

  it("detects filename-id mismatches", () => {
    const plans = [
      {
        ...makePlan("0001"),
        filePath: "/tmp/active/0002-wrong.md",
      },
    ];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.kind === "id-filename-mismatch")).toBe(
        true,
      );
    }
  });

  it("detects status-location mismatches", () => {
    const plans = [
      makePlan("0001", { status: "completed", location: "active" }),
    ];
    const result = validateGraph(plans);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.kind === "status-location-mismatch"),
      ).toBe(true);
    }
  });

  it("produces human-readable messages", () => {
    const issue = { kind: "cycle" as const, path: ["0001", "0002", "0001"] };
    expect(formatIssue(issue)).toContain("0001 -> 0002 -> 0001");
  });
});
