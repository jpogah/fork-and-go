import { describe, expect, it } from "vitest";

import {
  AGGREGATE_CAP_CHARS,
  PER_FILE_CAP_CHARS,
  UNTRUSTED_LABEL,
  matchContext,
  scopeMatches,
} from "./matcher.ts";
import type { ContextFile } from "./parser.ts";

function file(
  filename: string,
  scope: string,
  body: string,
  opts: {
    mtimeMs?: number;
    source?: "slack" | "email" | "jira" | "wiki" | "other";
  } = {},
): ContextFile {
  return {
    filename,
    header: { source: opts.source ?? "slack", scope: scope as never },
    body,
    mtimeMs: opts.mtimeMs ?? 0,
  };
}

describe("scopeMatches", () => {
  it("handles `all`", () => {
    expect(scopeMatches("all", { kind: "planner" })).toBe(true);
    expect(scopeMatches("all", { kind: "run", planId: "0041" })).toBe(true);
  });

  it("handles `planner`", () => {
    expect(scopeMatches("planner", { kind: "planner" })).toBe(true);
    expect(scopeMatches("planner", { kind: "run", planId: "0041" })).toBe(
      false,
    );
  });

  it("handles `run:<id>`", () => {
    expect(scopeMatches("run:0041", { kind: "run", planId: "0041" })).toBe(
      true,
    );
    expect(scopeMatches("run:0041", { kind: "run", planId: "0051" })).toBe(
      false,
    );
    expect(scopeMatches("run:0041", { kind: "planner" })).toBe(false);
  });

  it("handles `phase:<name>`", () => {
    expect(
      scopeMatches("phase:CMO", {
        kind: "run",
        planId: "0041",
        phase: "CMO",
      }),
    ).toBe(true);
    expect(
      scopeMatches("phase:CMO", {
        kind: "run",
        planId: "0041",
        phase: "Harness",
      }),
    ).toBe(false);
    expect(scopeMatches("phase:CMO", { kind: "run", planId: "0041" })).toBe(
      false,
    );
    expect(scopeMatches("phase:CMO", { kind: "planner" })).toBe(false);
  });
});

describe("matchContext", () => {
  it("returns an empty render when nothing matches", () => {
    const result = matchContext([file("a.md", "run:0042", "hello")], {
      kind: "run",
      planId: "0099",
    });
    expect(result.matched).toHaveLength(0);
    expect(result.rendered).toBe("");
  });

  it("returns `all`-scoped files in every target", () => {
    const files = [file("pricing.md", "all", "Max $49")];
    const planner = matchContext(files, { kind: "planner" });
    const run = matchContext(files, { kind: "run", planId: "0041" });
    expect(planner.matched).toHaveLength(1);
    expect(run.matched).toHaveLength(1);
    expect(planner.rendered).toContain("Max $49");
    expect(planner.rendered).toContain("## External Context");
    expect(planner.rendered).toContain(UNTRUSTED_LABEL);
  });

  it("keeps run-scoped files out of other runs", () => {
    const files = [file("a.md", "run:0041", "only for 0041")];
    const other = matchContext(files, { kind: "run", planId: "0042" });
    expect(other.matched).toHaveLength(0);
    expect(other.rendered).toBe("");
  });

  it("passes planner-scoped files only to the planner target", () => {
    const files = [file("a.md", "planner", "spec-level context")];
    const planner = matchContext(files, { kind: "planner" });
    const run = matchContext(files, { kind: "run", planId: "0041" });
    expect(planner.matched).toHaveLength(1);
    expect(run.matched).toHaveLength(0);
  });

  it("orders by scope priority (all > phase > planner > run)", () => {
    const files = [
      file("run.md", "run:0041", "run body"),
      file("phase.md", "phase:CMO", "phase body"),
      file("all.md", "all", "all body"),
    ];
    const target = {
      kind: "run" as const,
      planId: "0041",
      phase: "CMO",
    };
    const result = matchContext(files, target);
    expect(result.matched.map((m) => m.file.filename)).toEqual([
      "all.md",
      "phase.md",
      "run.md",
    ]);
  });

  it("combines several scopes for a run target", () => {
    const files = [
      file("all.md", "all", "global"),
      file("phase.md", "phase:Harness", "phase-level"),
      file("run-hit.md", "run:0051", "this plan only"),
      file("run-miss.md", "run:0099", "other plan"),
      file("planner.md", "planner", "planner only"),
    ];
    const result = matchContext(files, {
      kind: "run",
      planId: "0051",
      phase: "Harness",
    });
    expect(result.matched.map((m) => m.file.filename).sort()).toEqual([
      "all.md",
      "phase.md",
      "run-hit.md",
    ]);
  });

  it("truncates bodies over the per-file cap and adds a marker", () => {
    const body = "x".repeat(PER_FILE_CAP_CHARS + 500);
    const result = matchContext([file("big.md", "all", body)], {
      kind: "planner",
    });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.file.body).toHaveLength(PER_FILE_CAP_CHARS);
    expect(result.matched[0]!.truncatedBy).toBe(500);
    expect(result.rendered).toContain("[Truncated 500 characters");
  });

  it("drops lowest-priority files first when the aggregate cap is hit", () => {
    const oneShort = "a".repeat(PER_FILE_CAP_CHARS);
    // All four entries match a `run:0041 + phase:CMO` target. 4 * 10_000
    // chars > 30_000 aggregate cap, so the lowest-priority tier (run) drops
    // first, and within that tier the older file is evicted.
    const files = [
      file("all.md", "all", oneShort, { mtimeMs: 100 }),
      file("phase.md", "phase:CMO", oneShort, { mtimeMs: 100 }),
      file("run-new.md", "run:0041", oneShort, { mtimeMs: 300 }),
      file("run-old.md", "run:0041", oneShort, { mtimeMs: 100 }),
    ];
    const result = matchContext(files, {
      kind: "run",
      planId: "0041",
      phase: "CMO",
    });
    const kept = result.matched.map((m) => m.file.filename);
    expect(kept).toEqual(["all.md", "phase.md", "run-new.md"]);
    expect(result.droppedForAggregateCap.map((f) => f.filename)).toEqual([
      "run-old.md",
    ]);
    expect(result.rendered).toContain("Aggregate cap reached");
    expect(result.rendered).toContain("run-old.md");
  });

  it("drops the oldest file within a tier when the aggregate cap is hit", () => {
    const oneShort = "a".repeat(PER_FILE_CAP_CHARS);
    const files = [
      file("old.md", "all", oneShort, { mtimeMs: 100 }),
      file("mid.md", "all", oneShort, { mtimeMs: 200 }),
      file("new.md", "all", oneShort, { mtimeMs: 300 }),
      file("newest.md", "all", oneShort, { mtimeMs: 400 }),
    ];
    const result = matchContext(files, { kind: "planner" });
    expect(result.matched.map((m) => m.file.filename)).toEqual([
      "newest.md",
      "new.md",
      "mid.md",
    ]);
    expect(result.droppedForAggregateCap.map((f) => f.filename)).toEqual([
      "old.md",
    ]);
  });

  it("stays under the aggregate cap in normal cases", () => {
    const body = "hello world";
    const files = [file("a.md", "all", body), file("b.md", "all", body)];
    const result = matchContext(files, { kind: "planner" });
    expect(result.droppedForAggregateCap).toHaveLength(0);
    const total = result.matched.reduce(
      (sum, m) => sum + m.file.body.length,
      0,
    );
    expect(total).toBeLessThan(AGGREGATE_CAP_CHARS);
  });

  it("renders the untrusted-context label before bodies", () => {
    const result = matchContext([file("a.md", "all", "secret")], {
      kind: "planner",
    });
    const labelIdx = result.rendered.indexOf(UNTRUSTED_LABEL);
    const bodyIdx = result.rendered.indexOf("secret");
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeLessThan(bodyIdx);
  });
});
