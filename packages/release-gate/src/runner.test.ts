import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readReleaseReadyFile, runReleaseGate } from "./runner.ts";

function setupRepo(): {
  root: string;
  activeDir: string;
  completedDir: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "release-gate-runner-"));
  const activeDir = path.join(root, "docs", "exec-plans", "active");
  const completedDir = path.join(root, "docs", "exec-plans", "completed");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });
  return { root, activeDir, completedDir };
}

function writePlan(
  dir: string,
  id: string,
  slug: string,
  tags: string[],
  status: "active" | "completed",
): string {
  const frontmatter = [
    "---",
    `id: "${id}"`,
    `title: "${slug}"`,
    `phase: "Harness"`,
    `status: "${status}"`,
    `depends_on: []`,
    `estimated_passes: 1`,
    `acceptance_tags: ${JSON.stringify(tags)}`,
    "---",
    "",
    `# ${id} ${slug}`,
    "",
    "## Goal",
    "x",
    "",
    "## Why Now",
    "x",
    "",
    "## Scope",
    "- x",
    "",
    "## Out Of Scope",
    "- x",
    "",
    "## Milestones",
    "1. x",
    "",
    "## Validation",
    "- x",
    "",
    "## Open Questions",
    "- x",
    "",
    "## Decision Log",
    "- x",
    "",
  ].join("\n");
  const file = path.join(dir, `${id}-${slug}.md`);
  writeFileSync(file, frontmatter);
  return file;
}

function writeSpec(
  root: string,
  criteria: Array<{ tag: string; description?: string; testedBy?: string[] }>,
  envVars: string[],
): string {
  const lines: string[] = [
    "# Acceptance — test",
    "",
    "## Release criteria",
    "",
  ];
  for (const c of criteria) {
    lines.push(`- [ ] **tag: \`${c.tag}\`** — "${c.description ?? "desc"}"`);
    for (const t of c.testedBy ?? []) {
      lines.push(`  - Tested by: \`${t}\``);
    }
  }
  lines.push("");
  lines.push("## Environment requirements");
  lines.push("");
  for (const e of envVars) {
    lines.push(`- \`${e}\``);
  }
  const specPath = path.join(root, "spec.acceptance.md");
  writeFileSync(specPath, lines.join("\n") + "\n");
  return specPath;
}

describe("runReleaseGate", () => {
  let ctx: ReturnType<typeof setupRepo>;
  let envPath: string;
  let reportsDir: string;

  beforeEach(() => {
    ctx = setupRepo();
    envPath = path.join(ctx.root, ".env.example");
    writeFileSync(envPath, "DATABASE_URL=postgres://ok\nAUTH_SECRET=shhh\n");
    reportsDir = path.join(ctx.root, ".orchestrator", "release-reports");
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it("writes a passing report when every criterion is covered and env is set", async () => {
    const specPath = writeSpec(
      ctx.root,
      [{ tag: "auth/x" }, { tag: "agent/y" }],
      ["DATABASE_URL", "AUTH_SECRET"],
    );
    writePlan(ctx.completedDir, "0100", "auth", ["auth/x"], "completed");
    writePlan(ctx.completedDir, "0101", "agent", ["agent/y"], "completed");

    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      now: () => new Date("2026-04-22T10:00:00.000Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.passed).toBe(true);
    expect(outcome.writeResult?.markdownPath).toBe(
      path.join(reportsDir, "2026-04-22-spec.md"),
    );
    const md = readFileSync(outcome.writeResult!.markdownPath, "utf8");
    expect(md).toContain("✓ READY");
  });

  it("fails the gate and names the uncovered tag", async () => {
    const specPath = writeSpec(
      ctx.root,
      [{ tag: "foo/bar", description: "unshipped" }],
      ["DATABASE_URL", "AUTH_SECRET"],
    );
    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.passed).toBe(false);
    const criterion = outcome.report.criteria.find((c) => c.tag === "foo/bar")!;
    expect(criterion.status).toBe("uncovered");
    expect(outcome.renderedMarkdown).toContain("`foo/bar`");
    expect(outcome.renderedMarkdown).toContain(
      'Ship a plan with `acceptance_tags: ["foo/bar"]`',
    );
  });

  it("flips to covered once a plan is dropped in completed/ with the tag", async () => {
    const specPath = writeSpec(
      ctx.root,
      [{ tag: "foo/bar" }],
      ["DATABASE_URL", "AUTH_SECRET"],
    );
    const first = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
    });
    expect(first.ok && first.report.passed).toBe(false);

    writePlan(ctx.completedDir, "0102", "foo", ["foo/bar"], "completed");

    const second = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
    });
    expect(second.ok && second.report.passed).toBe(true);
  });

  it("fails on a missing env var", async () => {
    const specPath = writeSpec(
      ctx.root,
      [{ tag: "auth/x" }],
      ["DATABASE_URL", "AUTH_SECRET", "BRAND_NEW_REQUIRED"],
    );
    writePlan(ctx.completedDir, "0103", "auth", ["auth/x"], "completed");

    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.passed).toBe(false);
    const envEntry = outcome.report.environment.find(
      (e) => e.name === "BRAND_NEW_REQUIRED",
    )!;
    expect(envEntry.status).toBe("missing-from-template");
  });

  it("runs cited tests when --run-tests is enabled", async () => {
    mkdirSync(path.join(ctx.root, "tests"), { recursive: true });
    writeFileSync(path.join(ctx.root, "tests", "x.spec.ts"), "// test\n");
    const specPath = writeSpec(
      ctx.root,
      [{ tag: "auth/x", testedBy: ["tests/x.spec.ts"] }],
      ["DATABASE_URL", "AUTH_SECRET"],
    );
    writePlan(ctx.completedDir, "0104", "auth", ["auth/x"], "completed");

    const invoked: string[] = [];
    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
      runTests: true,
      runTest: (p) => {
        invoked.push(p);
        return {
          testPath: p,
          ok: true,
          durationMs: 0,
          output: "",
          command: "stub",
        };
      },
    });
    expect(invoked).toEqual(["tests/x.spec.ts"]);
    expect(outcome.ok && outcome.report.ranTests).toBe(true);
  });

  it("returns a parse failure for a malformed spec", async () => {
    const specPath = path.join(ctx.root, "bad.acceptance.md");
    writeFileSync(specPath, "# no criteria heading\n");
    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("parse");
  });

  it("returns env-template failure when .env.example is absent", async () => {
    rmSync(envPath);
    const specPath = writeSpec(ctx.root, [{ tag: "auth/x" }], ["DATABASE_URL"]);
    const outcome = await runReleaseGate({
      specPath,
      activeDir: ctx.activeDir,
      completedDir: ctx.completedDir,
      envTemplatePath: envPath,
      reportsDir,
      repoRoot: ctx.root,
      writeReport: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("env-template");
  });
});

describe("readReleaseReadyFile", () => {
  it("returns exists:false when no file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-ready-read-"));
    try {
      expect(readReleaseReadyFile(dir).exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns payload when file is valid JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-ready-read-"));
    try {
      writeFileSync(
        path.join(dir, "RELEASE_READY"),
        JSON.stringify({
          specPath: "docs/x.md",
          at: "2026-04-22T00:00:00.000Z",
          reportPath: null,
        }),
      );
      const result = readReleaseReadyFile(dir);
      expect(result.exists).toBe(true);
      expect(result.payload?.specPath).toBe("docs/x.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
