import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPlanStatus } from "./status-writer.ts";

function plan(status: string): string {
  return [
    "---",
    `id: "0010"`,
    `title: "Alpha"`,
    `phase: "Harness"`,
    `status: "${status}"`,
    `depends_on: []`,
    `estimated_passes: 2`,
    `acceptance_tags: []`,
    "---",
    "",
    "# 0010 Alpha",
    "",
    "Body",
    "",
  ].join("\n");
}

describe("setPlanStatus", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "plan-status-"));
    filePath = path.join(dir, "0010-alpha.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flips status and reports the previous value", () => {
    writeFileSync(filePath, plan("active"), "utf8");
    const result = setPlanStatus(filePath, "blocked");
    expect(result.changed).toBe(true);
    expect(result.previousStatus).toBe("active");
    expect(result.newStatus).toBe("blocked");
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain('status: "blocked"');
    expect(text).not.toContain('status: "active"');
    // Body preserved.
    expect(text).toContain("# 0010 Alpha");
    expect(text).toContain("Body");
  });

  it("reports no-change when status already matches", () => {
    writeFileSync(filePath, plan("blocked"), "utf8");
    const result = setPlanStatus(filePath, "blocked");
    expect(result.changed).toBe(false);
    expect(result.previousStatus).toBe("blocked");
  });

  it("rejects unknown target status", () => {
    writeFileSync(filePath, plan("active"), "utf8");
    expect(() => setPlanStatus(filePath, "bogus" as never)).toThrow(
      /not one of/u,
    );
  });

  it("throws when frontmatter has no status line", () => {
    writeFileSync(
      filePath,
      [
        "---",
        `id: "0010"`,
        `title: "Alpha"`,
        `phase: "Harness"`,
        `depends_on: []`,
        `estimated_passes: 2`,
        `acceptance_tags: []`,
        "---",
        "",
        "body",
      ].join("\n"),
      "utf8",
    );
    expect(() => setPlanStatus(filePath, "blocked")).toThrow(
      /no 'status:' line/u,
    );
  });
});
