import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderReleaseReport, writeReleaseReport } from "./report.ts";
import type { AcceptanceReport } from "./types.ts";

const baseReport: AcceptanceReport = {
  generatedAt: "2026-04-22T12:00:00.000Z",
  specPath: "docs/product-specs/EXAMPLE.acceptance.md",
  specTitle: "Acceptance — Example",
  envTemplatePath: ".env.example",
  ranTests: false,
  passed: false,
  criteria: [
    {
      tag: "auth/google-signin",
      description: "operator signs in",
      status: "covered",
      coveringPlans: [{ id: "0004", title: "Auth", status: "completed" }],
      testPaths: ["apps/web/e2e/signin.spec.ts"],
      missingTestPaths: [],
      testRun: null,
      line: 5,
    },
    {
      tag: "agent/activation",
      description: "operator activates an agent",
      status: "uncovered",
      coveringPlans: [],
      testPaths: [],
      missingTestPaths: [],
      testRun: null,
      line: 9,
    },
  ],
  environment: [
    { name: "DATABASE_URL", status: "set", valueKind: "set" },
    { name: "AUTH_SECRET", status: "placeholder", valueKind: "empty" },
    { name: "SOMETHING_NEW", status: "missing-from-template" },
  ],
};

describe("renderReleaseReport", () => {
  it("renders NOT READY when gate fails", () => {
    const md = renderReleaseReport(baseReport);
    expect(md).toContain("✗ NOT READY");
    expect(md).toContain("`auth/google-signin`");
    expect(md).toContain("`agent/activation`");
    expect(md).toContain("`DATABASE_URL`");
    expect(md).toContain("`AUTH_SECRET`");
    expect(md).toContain("## Next steps");
    expect(md).toContain(
      'Ship a plan with `acceptance_tags: ["agent/activation"]`',
    );
    expect(md).toContain("Set a release-ready default for `AUTH_SECRET`");
    expect(md).toContain("Add `SOMETHING_NEW` to `.env.example`");
  });

  it("renders READY and omits next steps when gate passes", () => {
    const passed: AcceptanceReport = {
      ...baseReport,
      passed: true,
      criteria: [
        {
          ...baseReport.criteria[0]!,
          status: "covered",
        },
      ],
      environment: [{ name: "DATABASE_URL", status: "set", valueKind: "set" }],
    };
    const md = renderReleaseReport(passed);
    expect(md).toContain("✓ READY");
    expect(md).not.toContain("## Next steps");
  });

  it("distinguishes empty vs literal-placeholder env values in the body", () => {
    const md = renderReleaseReport(baseReport);
    expect(md).toContain("`AUTH_SECRET` — present in `.env.example` but empty");
  });
});

describe("writeReleaseReport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-gate-report-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a dated file and returns its path", () => {
    const reportsDir = path.join(dir, "release-reports");
    const result = writeReleaseReport(baseReport, {
      reportsDir,
      specSlug: "example",
      now: new Date("2026-04-22T12:00:00.000Z"),
    });
    expect(result.markdownPath).toBe(
      path.join(reportsDir, "2026-04-22-example.md"),
    );
    const text = readFileSync(result.markdownPath, "utf8");
    expect(text).toContain("# Release Readiness — 2026-04-22");
  });
});
