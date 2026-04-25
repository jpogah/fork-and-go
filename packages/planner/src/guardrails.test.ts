import { describe, expect, it } from "vitest";

import type { Plan } from "@fork-and-go/plan-graph";

import {
  DEFAULT_MAX_NEW_PLANS,
  detectIdConflicts,
  enforceCap,
  enforceNewIdsOnly,
  enforceNoCyclesAcrossProposals,
  enforceNoDuplicateProposalIds,
  enforceNoSelfDependency,
  runProposalGuardrails,
} from "./guardrails.ts";
import type { PlanProposal } from "./schemas.ts";

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    id: "0100",
    slug: "example-plan",
    title: "Example Plan",
    phase: "Harness",
    depends_on: [],
    estimated_passes: 2,
    summary: "A thing.",
    scope_bullets: ["Ship it."],
    ...overrides,
  };
}

function existing(overrides: Partial<Plan> = {}): Plan {
  const id = overrides.id ?? "0001";
  return {
    id,
    title: "Existing",
    phase: "Foundation",
    status: "completed",
    dependsOn: [],
    estimatedPasses: 1,
    acceptanceTags: [],
    location: "completed",
    filePath: `/virtual/${id}-existing.md`,
    body: "",
    raw: {
      id,
      title: overrides.title ?? "Existing",
      phase: overrides.phase ?? "Foundation",
      status: overrides.status ?? "completed",
      depends_on: [...(overrides.dependsOn ?? [])],
      estimated_passes: overrides.estimatedPasses ?? 1,
      acceptance_tags: [],
    },
    ...overrides,
  };
}

describe("enforceCap", () => {
  it("passes when under the cap", () => {
    const proposals = Array.from({ length: DEFAULT_MAX_NEW_PLANS }, (_, i) =>
      proposal({ id: (100 + i).toString().padStart(4, "0") }),
    );
    expect(enforceCap(proposals).ok).toBe(true);
  });

  it("fails when over the cap", () => {
    const proposals = Array.from(
      { length: DEFAULT_MAX_NEW_PLANS + 1 },
      (_, i) => proposal({ id: (100 + i).toString().padStart(4, "0") }),
    );
    const result = enforceCap(proposals);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("cap-exceeded");
      expect(result.reason).toMatch(/breaking the spec into phases/);
    }
  });

  it("honors a custom cap", () => {
    const result = enforceCap([proposal()], { maxNewPlans: 0 });
    expect(result.ok).toBe(false);
  });
});

describe("enforceNoDuplicateProposalIds", () => {
  it("fails when two proposals share an id", () => {
    const result = enforceNoDuplicateProposalIds([
      proposal({ id: "0100" }),
      proposal({ id: "0100" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("duplicate-proposal-id");
  });

  it("passes on distinct ids", () => {
    expect(
      enforceNoDuplicateProposalIds([
        proposal({ id: "0100" }),
        proposal({ id: "0101" }),
      ]).ok,
    ).toBe(true);
  });
});

describe("enforceNewIdsOnly", () => {
  it("rejects a proposal id that already exists", () => {
    const result = enforceNewIdsOnly(
      [proposal({ id: "0001" })],
      [existing({ id: "0001" })],
      48,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("id-collision");
  });

  it("rejects a proposal id below the highest existing", () => {
    const result = enforceNewIdsOnly(
      [proposal({ id: "0005" })],
      [existing({ id: "0048" })],
      48,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("id-below-existing");
  });

  it("accepts ids above the highest existing", () => {
    expect(
      enforceNewIdsOnly(
        [proposal({ id: "0049" })],
        [existing({ id: "0048" })],
        48,
      ).ok,
    ).toBe(true);
  });
});

describe("enforceNoSelfDependency", () => {
  it("rejects a proposal that depends on itself", () => {
    const result = enforceNoSelfDependency([
      proposal({ id: "0100", depends_on: ["0100"] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("self-dependency");
  });

  it("accepts proposals with distinct deps", () => {
    expect(
      enforceNoSelfDependency([proposal({ id: "0100", depends_on: ["0099"] })])
        .ok,
    ).toBe(true);
  });
});

describe("enforceNoCyclesAcrossProposals", () => {
  it("rejects a cycle among proposals", () => {
    const result = enforceNoCyclesAcrossProposals(
      [
        proposal({ id: "0100", depends_on: ["0101"] }),
        proposal({ id: "0101", depends_on: ["0100"] }),
      ],
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("cycle-in-proposals");
  });

  it("rejects a cycle that crosses into existing plans", () => {
    const result = enforceNoCyclesAcrossProposals(
      [proposal({ id: "0100", depends_on: ["0001"] })],
      [
        existing({
          id: "0001",
          dependsOn: ["0100"],
          status: "active",
          location: "active",
        }),
      ],
    );
    expect(result.ok).toBe(false);
  });

  it("accepts an acyclic proposal set referencing existing plans", () => {
    const result = enforceNoCyclesAcrossProposals(
      [proposal({ id: "0100", depends_on: ["0001"] })],
      [existing({ id: "0001" })],
    );
    expect(result.ok).toBe(true);
  });
});

describe("detectIdConflicts", () => {
  it("separates fresh, active-conflict, and completed-conflict proposals", () => {
    const result = detectIdConflicts(
      [
        proposal({ id: "0100", title: "Fresh" }),
        proposal({ id: "0001", title: "Active Conflict" }),
        proposal({ id: "0002", title: "Completed Conflict" }),
      ],
      [
        existing({
          id: "0001",
          status: "active",
          location: "active",
          title: "Old Active",
        }),
        existing({
          id: "0002",
          status: "completed",
          location: "completed",
          title: "Old Done",
        }),
      ],
    );
    expect(result.fresh.map((p) => p.id)).toEqual(["0100"]);
    expect(result.activeConflicts.map((c) => c.id)).toEqual(["0001"]);
    expect(result.completedConflicts.map((c) => c.id)).toEqual(["0002"]);
  });
});

describe("runProposalGuardrails", () => {
  it("returns the first failure it finds", () => {
    const result = runProposalGuardrails(
      [
        proposal({ id: "0100" }),
        proposal({ id: "0100" }), // duplicate
      ],
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("duplicate-proposal-id");
  });

  it("passes on a clean proposal set", () => {
    const result = runProposalGuardrails(
      [
        proposal({ id: "0100" }),
        proposal({ id: "0101", depends_on: ["0100"] }),
      ],
      [],
    );
    expect(result.ok).toBe(true);
  });
});
