import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IngestError, ingest, nextPlanIdAfter } from "./ingest.ts";

function plan(opts: {
  id: string;
  title?: string;
  status?: string;
  dependsOn?: string[];
  blurb?: string;
}): string {
  const depends = opts.dependsOn ?? [];
  const blurb = opts.blurb ?? "Short descriptive blurb.";
  return [
    "---",
    `id: "${opts.id}"`,
    `title: "${opts.title ?? `Plan ${opts.id}`}"`,
    `phase: "Harness"`,
    `status: "${opts.status ?? "active"}"`,
    depends.length
      ? `depends_on:\n${depends.map((d) => `  - "${d}"`).join("\n")}`
      : `depends_on: []`,
    `estimated_passes: 2`,
    `acceptance_tags: []`,
    "---",
    "",
    `# ${opts.id} Plan`,
    "",
    blurb,
    "",
  ].join("\n");
}

function contextFile(scope: string, body: string): string {
  return `---\nsource: "slack"\nscope: "${scope}"\n---\n\n${body}`;
}

describe("ingest", () => {
  let root: string;
  let activeDir: string;
  let completedDir: string;
  let contextDir: string;
  let inboxDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "planner-ingest-"));
    activeDir = path.join(root, "active");
    completedDir = path.join(root, "completed");
    contextDir = path.join(root, "context");
    inboxDir = path.join(contextDir, "inbox");
    mkdirSync(activeDir);
    mkdirSync(completedDir);
    mkdirSync(inboxDir, { recursive: true });
    specPath = path.join(root, "SPEC.md");
    writeFileSync(specPath, "# Spec\n\nA goal.\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a PlanningContext with all plans summarized", () => {
    writeFileSync(
      path.join(activeDir, "0010-active-one.md"),
      plan({ id: "0010", blurb: "Hello from plan 0010." }),
      "utf8",
    );
    writeFileSync(
      path.join(completedDir, "0005-done.md"),
      plan({ id: "0005", status: "completed" }),
      "utf8",
    );
    writeFileSync(
      path.join(inboxDir, "2026-04-21-slack.md"),
      contextFile("all", "ping"),
      "utf8",
    );

    const ctx = ingest({
      specPath,
      activeDir,
      completedDir,
      contextDir,
      repoRoot: root,
    });

    expect(ctx.spec.path).toBe(specPath);
    expect(ctx.spec.content).toContain("# Spec");
    expect(ctx.plans).toHaveLength(2);
    expect(ctx.plans.map((p) => p.id).sort()).toEqual(["0005", "0010"]);
    expect(ctx.plans.find((p) => p.id === "0010")?.blurb).toBe(
      "Hello from plan 0010.",
    );
    expect(ctx.contextDrops.map((d) => d.filename)).toEqual([
      "2026-04-21-slack.md",
    ]);
    expect(ctx.contextDrops[0]?.content).toContain("ping");
    expect(ctx.contextDrops[0]?.content).toContain("scope=all");
    // Every drop carries the UNTRUSTED_LABEL so the decomposer sees the same
    // prompt-injection boundary the runner injects into implementer prompts.
    expect(ctx.contextDrops[0]?.content).toContain("operator-supplied context");
    expect(ctx.highestPlanIdNumeric).toBe(10);
  });

  it("throws IngestError when the spec file is missing", () => {
    expect(() =>
      ingest({
        specPath: path.join(root, "missing.md"),
        activeDir,
        completedDir,
        repoRoot: root,
      }),
    ).toThrow(IngestError);
  });

  it("tolerates an empty plans directory", () => {
    const ctx = ingest({
      specPath,
      activeDir,
      completedDir,
      repoRoot: root,
    });
    expect(ctx.plans).toEqual([]);
    expect(ctx.highestPlanIdNumeric).toBe(0);
    expect(ctx.contextDrops).toEqual([]);
    expect(ctx.contextWarnings).toEqual([]);
  });

  it("filters context drops to planner + all scope, warning on malformed files", () => {
    writeFileSync(
      path.join(inboxDir, "00-all.md"),
      contextFile("all", "global"),
      "utf8",
    );
    writeFileSync(
      path.join(inboxDir, "01-planner.md"),
      contextFile("planner", "planner-only"),
      "utf8",
    );
    writeFileSync(
      path.join(inboxDir, "02-run.md"),
      contextFile("run:0099", "runner-only"),
      "utf8",
    );
    writeFileSync(path.join(inboxDir, "03-bad.md"), "no frontmatter", "utf8");

    const ctx = ingest({
      specPath,
      activeDir,
      completedDir,
      contextDir,
      repoRoot: root,
    });
    expect(ctx.contextDrops.map((d) => d.filename).sort()).toEqual([
      "00-all.md",
      "01-planner.md",
    ]);
    expect(ctx.contextWarnings.map((w) => w.filename)).toEqual(["03-bad.md"]);
  });
});

describe("nextPlanIdAfter", () => {
  it("zero-pads to four digits", () => {
    expect(nextPlanIdAfter(0)).toBe("0001");
    expect(nextPlanIdAfter(48)).toBe("0049");
    expect(nextPlanIdAfter(999)).toBe("1000");
  });
});
