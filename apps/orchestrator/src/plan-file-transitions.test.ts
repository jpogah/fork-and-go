import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlans, validateGraph } from "@fork-and-go/plan-graph";
import { describe, expect, it } from "vitest";

import {
  markPlanCompleted,
  rewriteFrontmatterStatus,
  findPlanFile,
} from "./plan-file-transitions.ts";

function scaffold(): { root: string; active: string; completed: string } {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-transitions-"));
  const active = path.join(root, "active");
  const completed = path.join(root, "completed");
  mkdirSync(active, { recursive: true });
  mkdirSync(completed, { recursive: true });
  return { root, active, completed };
}

function writePlan(dir: string, id: string, status: string): string {
  const file = path.join(dir, `${id}-example-plan.md`);
  const body = [
    "---",
    `id: "${id}"`,
    `title: "Example ${id}"`,
    'phase: "Harness"',
    `status: "${status}"`,
    "depends_on: []",
    "estimated_passes: 1",
    "acceptance_tags: []",
    "---",
    "",
    `# Example ${id}`,
    "",
    "body",
    "",
  ].join("\n");
  writeFileSync(file, body, "utf8");
  return file;
}

describe("plan-file-transitions", () => {
  it("moves the file and flips the frontmatter on markPlanCompleted", () => {
    const { active, completed } = scaffold();
    const src = writePlan(active, "0100", "active");
    const result = markPlanCompleted("0100", {
      activeDir: active,
      completedDir: completed,
    });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(result.to)).toBe(true);
    const text = readFileSync(result.to, "utf8");
    expect(text).toMatch(/status: "completed"/);
    // validateGraph should still accept the result.
    const plans = loadPlans({ activeDir: active, completedDir: completed });
    expect(validateGraph(plans).ok).toBe(true);
  });

  it("refuses to overwrite an existing completed file", () => {
    const { active, completed } = scaffold();
    writePlan(active, "0100", "active");
    // Seed a conflicting file in completed/.
    writeFileSync(
      path.join(completed, "0100-example-plan.md"),
      "pre-existing\n",
      "utf8",
    );
    expect(() =>
      markPlanCompleted("0100", { activeDir: active, completedDir: completed }),
    ).toThrow(/already exists/);
  });

  it("findPlanFile resolves by id prefix", () => {
    const { active } = scaffold();
    writePlan(active, "0042", "active");
    expect(findPlanFile(active, "0042")).toBeTruthy();
    expect(findPlanFile(active, "9999")).toBeNull();
  });

  it("rewriteFrontmatterStatus preserves body content", () => {
    const { active, completed } = scaffold();
    const src = writePlan(active, "0100", "active");
    const plan = loadPlans({ activeDir: active, completedDir: completed }).find(
      (p) => p.id === "0100",
    )!;
    const rewritten = rewriteFrontmatterStatus(plan, "completed");
    expect(rewritten).toMatch(/# Example 0100/);
    expect(rewritten).toMatch(/status: "completed"/);
    expect(rewritten).not.toMatch(/status: "active"/);
    // Sanity-check src was not mutated by rewriteFrontmatterStatus alone.
    expect(readFileSync(src, "utf8")).toMatch(/status: "active"/);
  });
});
