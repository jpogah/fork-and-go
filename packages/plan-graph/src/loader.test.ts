import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fileIdFromFilename,
  loadPlanFile,
  loadPlans,
  PlanParseError,
} from "./loader.ts";

describe("fileIdFromFilename", () => {
  it("extracts the numeric id", () => {
    expect(fileIdFromFilename("0042-ship-analytics.md")).toBe("0042");
  });
  it("rejects non-conforming filenames", () => {
    expect(fileIdFromFilename("README.md")).toBeNull();
    expect(fileIdFromFilename("42-ship.md")).toBeNull();
    expect(fileIdFromFilename("0042_ship.md")).toBeNull();
  });
});

describe("loadPlanFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "plan-graph-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid plan file", () => {
    const file = path.join(dir, "0001-alpha.md");
    writeFileSync(
      file,
      [
        "---",
        `id: "0001"`,
        `title: "Alpha"`,
        `phase: "Foundation"`,
        `status: "active"`,
        `depends_on: []`,
        `estimated_passes: 2`,
        `acceptance_tags:`,
        `  - "tag/one"`,
        "---",
        "# Alpha",
        "",
        "Body text.",
      ].join("\n"),
    );
    const plan = loadPlanFile(file, "active");
    expect(plan.id).toBe("0001");
    expect(plan.title).toBe("Alpha");
    expect(plan.phase).toBe("Foundation");
    expect(plan.status).toBe("active");
    expect(plan.dependsOn).toEqual([]);
    expect(plan.estimatedPasses).toBe(2);
    expect(plan.acceptanceTags).toEqual(["tag/one"]);
    expect(plan.body.startsWith("# Alpha")).toBe(true);
  });

  it("rejects files without frontmatter", () => {
    const file = path.join(dir, "0002-beta.md");
    writeFileSync(file, "# Beta\n\nNo frontmatter here.\n");
    expect(() => loadPlanFile(file, "active")).toThrow(PlanParseError);
  });

  it("rejects unterminated frontmatter", () => {
    const file = path.join(dir, "0003-gamma.md");
    writeFileSync(file, "---\nid: '0003'\ntitle: 'Gamma'\n\n# body\n");
    expect(() => loadPlanFile(file, "active")).toThrow(PlanParseError);
  });

  it("rejects invalid frontmatter shape", () => {
    const file = path.join(dir, "0004-delta.md");
    writeFileSync(
      file,
      [
        "---",
        `id: "4"`,
        `title: "Delta"`,
        `phase: "x"`,
        `status: "active"`,
        `depends_on: []`,
        `estimated_passes: 1`,
        "---",
        "body",
      ].join("\n"),
    );
    expect(() => loadPlanFile(file, "active")).toThrow(/4-digit string/);
  });

  it("rejects unknown status", () => {
    const file = path.join(dir, "0005-epsilon.md");
    writeFileSync(
      file,
      [
        "---",
        `id: "0005"`,
        `title: "Epsilon"`,
        `phase: "x"`,
        `status: "shelved"`,
        `depends_on: []`,
        `estimated_passes: 1`,
        "---",
        "body",
      ].join("\n"),
    );
    expect(() => loadPlanFile(file, "active")).toThrow();
  });
});

describe("loadPlans", () => {
  let dir: string;
  let activeDir: string;
  let completedDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "plan-graph-"));
    activeDir = path.join(dir, "active");
    completedDir = path.join(dir, "completed");
    mkdirSync(activeDir);
    mkdirSync(completedDir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads from both directories and tags location", () => {
    writeFileSync(
      path.join(activeDir, "0010-active-plan.md"),
      frontmatter({ id: "0010", title: "Active Plan", status: "active" }),
    );
    writeFileSync(
      path.join(completedDir, "0001-done.md"),
      frontmatter({ id: "0001", title: "Done", status: "completed" }),
    );
    const plans = loadPlans({ activeDir, completedDir });
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => [p.id, p.location])).toEqual([
      ["0001", "completed"],
      ["0010", "active"],
    ]);
  });
});

function frontmatter(opts: {
  id: string;
  title: string;
  status: string;
}): string {
  return [
    "---",
    `id: "${opts.id}"`,
    `title: "${opts.title}"`,
    `phase: "Test"`,
    `status: "${opts.status}"`,
    `depends_on: []`,
    `estimated_passes: 1`,
    "---",
    "body",
    "",
  ].join("\n");
}
