import { describe, expect, it } from "vitest";

import { generatePlansMarkdown } from "./plans-md.ts";
import type { Plan } from "./types.ts";

function makePlan(id: string, title: string, phase: string): Plan {
  return {
    id,
    title,
    phase,
    status: "active",
    dependsOn: [],
    estimatedPasses: 1,
    acceptanceTags: [],
    location: "active",
    filePath: `/repo/docs/exec-plans/active/${id}-${slugify(title)}.md`,
    body: "",
    raw: {
      id,
      title,
      phase,
      status: "active",
      depends_on: [],
      estimated_passes: 1,
      acceptance_tags: [],
    },
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

describe("generatePlansMarkdown", () => {
  it("produces a stable table sorted by id with a do-not-hand-edit banner", () => {
    const plans = [
      makePlan("0002", "Landing", "Marketing"),
      makePlan("0001", "Bootstrap", "Foundation"),
    ];
    const md = generatePlansMarkdown(plans, "/repo");
    expect(md).toContain("Do not hand-edit");
    // header table row is present
    expect(md).toMatch(/\| #\s+\| Plan\s+\| File\s+\| Phase\s+\|/);
    // 0001 should appear before 0002
    const idxOne = md.indexOf("0001");
    const idxTwo = md.indexOf("0002");
    expect(idxOne).toBeGreaterThan(-1);
    expect(idxTwo).toBeGreaterThan(idxOne);
    expect(md).toContain(
      "[0001-bootstrap.md](exec-plans/active/0001-bootstrap.md)",
    );
    expect(md).toContain("## Sequencing Notes");
  });

  it("renders deterministically across invocations", () => {
    const plans = [
      makePlan("0001", "Bootstrap", "Foundation"),
      makePlan("0002", "Landing", "Marketing"),
    ];
    const a = generatePlansMarkdown(plans, "/repo");
    const b = generatePlansMarkdown(plans, "/repo");
    expect(a).toBe(b);
  });
});
