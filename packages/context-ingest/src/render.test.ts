import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAndRender } from "./render.ts";

describe("loadAndRender", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ctx-render-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty section when no files match", () => {
    writeFileSync(
      path.join(dir, "a.md"),
      `---\nsource: "slack"\nscope: "run:0099"\n---\n\nirrelevant`,
      "utf8",
    );
    const result = loadAndRender({
      inboxDir: dir,
      target: { kind: "planner" },
    });
    expect(result.section).toBe("");
    expect(result.matched).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("renders a run-scoped section for matching plans only", () => {
    writeFileSync(
      path.join(dir, "2026-04-21-pricing.md"),
      `---\nsource: "slack"\nscope: "run:0051"\n---\n\nMax $49`,
      "utf8",
    );
    const hit = loadAndRender({
      inboxDir: dir,
      target: { kind: "run", planId: "0051" },
    });
    expect(hit.section).toContain("## External Context");
    expect(hit.section).toContain("Max $49");
    expect(hit.matched.map((f) => f.filename)).toEqual([
      "2026-04-21-pricing.md",
    ]);

    const miss = loadAndRender({
      inboxDir: dir,
      target: { kind: "run", planId: "0041" },
    });
    expect(miss.section).toBe("");
  });

  it("surfaces parse warnings for malformed files", () => {
    writeFileSync(path.join(dir, "a.md"), "no frontmatter", "utf8");
    const result = loadAndRender({
      inboxDir: dir,
      target: { kind: "planner" },
    });
    expect(result.warnings.map((w) => w.filename)).toEqual(["a.md"]);
    expect(result.section).toBe("");
  });
});
