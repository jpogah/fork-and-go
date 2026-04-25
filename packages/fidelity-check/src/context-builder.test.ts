import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildContext, FidelityContextError } from "./context-builder.ts";

function plan(opts: {
  id: string;
  title?: string;
  status?: string;
  dependsOn?: string[];
  acceptanceTags?: string[];
  blurb?: string;
}): string {
  const depends = opts.dependsOn ?? [];
  const tags = opts.acceptanceTags ?? [];
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
    tags.length
      ? `acceptance_tags:\n${tags.map((t) => `  - "${t}"`).join("\n")}`
      : `acceptance_tags: []`,
    "---",
    "",
    `# ${opts.id} Plan`,
    "",
    blurb,
    "",
  ].join("\n");
}

describe("buildContext", () => {
  let root: string;
  let activeDir: string;
  let completedDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fidelity-ctx-"));
    activeDir = path.join(root, "docs", "exec-plans", "active");
    completedDir = path.join(root, "docs", "exec-plans", "completed");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(completedDir, { recursive: true });
    specPath = path.join(root, "docs", "product-specs", "demo.md");
    mkdirSync(path.dirname(specPath), { recursive: true });
    writeFileSync(specPath, "# Demo Spec\n\n## Goals\n\n- A\n- B\n", "utf8");

    // Seed a minimal repo slice.
    const appDir = path.join(root, "apps", "web", "app");
    mkdirSync(path.join(appDir, "api", "ping"), { recursive: true });
    writeFileSync(path.join(appDir, "page.tsx"), "x", "utf8");
    writeFileSync(path.join(appDir, "api", "ping", "route.ts"), "x", "utf8");

    const pkgSrc = path.join(root, "packages", "demo-pkg", "src");
    mkdirSync(pkgSrc, { recursive: true });
    writeFileSync(path.join(pkgSrc, "index.ts"), "x", "utf8");
    writeFileSync(path.join(pkgSrc, "thing.test.ts"), "x", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gathers spec, plans, and repo slice deterministically", () => {
    writeFileSync(
      path.join(activeDir, "0010-alpha.md"),
      plan({ id: "0010", blurb: "Plan 10 blurb.", acceptanceTags: ["a"] }),
      "utf8",
    );
    writeFileSync(
      path.join(completedDir, "0005-beta.md"),
      plan({ id: "0005", status: "completed" }),
      "utf8",
    );

    const ctx = buildContext({
      specPath,
      activeDir,
      completedDir,
      repoRoot: root,
    });

    expect(ctx.spec.slug).toBe("demo");
    expect(ctx.spec.content).toContain("Demo Spec");
    expect(ctx.plans.map((p) => p.id)).toEqual(["0005", "0010"]);
    expect(ctx.plans.find((p) => p.id === "0010")?.acceptanceTags).toEqual([
      "a",
    ]);
    expect(ctx.repoSlice.appFiles).toContain("apps/web/app/page.tsx");
    expect(ctx.repoSlice.apiRoutes).toContain("apps/web/app/api/ping/route.ts");
    expect(ctx.repoSlice.packageFiles).toContain(
      "packages/demo-pkg/src/index.ts",
    );
    expect(ctx.repoSlice.testFiles).toContain(
      "packages/demo-pkg/src/thing.test.ts",
    );
    expect(ctx.previousSummary).toBeNull();
  });

  it("loads previous summary JSON when a path is supplied", () => {
    const prev = path.join(root, "prev.json");
    writeFileSync(prev, JSON.stringify({ driftScore: 12 }), "utf8");
    const ctx = buildContext({
      specPath,
      activeDir,
      completedDir,
      repoRoot: root,
      previousSummaryPath: prev,
    });
    expect(ctx.previousSummary).toEqual({ driftScore: 12 });
  });

  it("throws FidelityContextError on a missing spec", () => {
    expect(() =>
      buildContext({
        specPath: path.join(root, "nope.md"),
        activeDir,
        completedDir,
        repoRoot: root,
      }),
    ).toThrow(FidelityContextError);
  });

  it("tolerates missing apps/ or packages/ trees", () => {
    const bareRoot = mkdtempSync(path.join(tmpdir(), "fidelity-bare-"));
    const bareActive = path.join(bareRoot, "active");
    const bareCompleted = path.join(bareRoot, "completed");
    mkdirSync(bareActive);
    mkdirSync(bareCompleted);
    const bareSpec = path.join(bareRoot, "spec.md");
    writeFileSync(bareSpec, "# Spec\n", "utf8");
    try {
      const ctx = buildContext({
        specPath: bareSpec,
        activeDir: bareActive,
        completedDir: bareCompleted,
        repoRoot: bareRoot,
      });
      expect(ctx.repoSlice.appFiles).toEqual([]);
      expect(ctx.repoSlice.packageFiles).toEqual([]);
      expect(ctx.repoSlice.apiRoutes).toEqual([]);
      expect(ctx.repoSlice.testFiles).toEqual([]);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});
