import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFidelityCheck } from "./runner.ts";
import { scriptedModelClient } from "./testing.ts";

function plan(opts: {
  id: string;
  title?: string;
  status?: string;
  acceptanceTags?: string[];
}): string {
  const tags = opts.acceptanceTags ?? [];
  return [
    "---",
    `id: "${opts.id}"`,
    `title: "${opts.title ?? `Plan ${opts.id}`}"`,
    `phase: "Harness"`,
    `status: "${opts.status ?? "active"}"`,
    `depends_on: []`,
    `estimated_passes: 2`,
    tags.length
      ? `acceptance_tags:\n${tags.map((t) => `  - "${t}"`).join("\n")}`
      : `acceptance_tags: []`,
    "---",
    "",
    `# ${opts.id} ${opts.title ?? `Plan ${opts.id}`}`,
    "",
    "Short blurb.",
    "",
  ].join("\n");
}

const AUDIT_OK = JSON.stringify({
  risk_score: 10,
  requirements: [
    {
      requirement: "Operators can connect Gmail",
      status: "met",
      plan_id: "0007",
      notes: "",
    },
  ],
  drift: [],
  risks: [],
  recommended_actions: [],
});

const AUDIT_OVER = JSON.stringify({
  risk_score: 40,
  requirements: [
    {
      requirement: "Operators can connect Gmail",
      status: "unmet",
      notes: "no connector plan",
    },
    {
      requirement: "Operators can review activity",
      status: "unmet",
      notes: "no review screen",
    },
    {
      requirement: "Operators see cost per run",
      status: "partial",
      plan_id: "0022",
      notes: "",
    },
  ],
  drift: [
    { plan_id: "0100", title: "Extra", rationale: "unasked" },
    { plan_id: "0101", title: "Extra 2", rationale: "unasked" },
    { plan_id: "0102", title: "Extra 3", rationale: "unasked" },
  ],
  risks: [
    {
      level: "medium",
      category: "unmet",
      detail: "Slack notifications are a launch surprise risk.",
    },
  ],
  recommended_actions: ["File Slack notifications plan."],
});

describe("runFidelityCheck", () => {
  let root: string;
  let activeDir: string;
  let completedDir: string;
  let reportsDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fidelity-run-"));
    activeDir = path.join(root, "docs", "exec-plans", "active");
    completedDir = path.join(root, "docs", "exec-plans", "completed");
    reportsDir = path.join(root, ".orchestrator", "fidelity-reports");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(completedDir, { recursive: true });
    specPath = path.join(root, "docs", "product-specs", "demo.md");
    mkdirSync(path.dirname(specPath), { recursive: true });
    writeFileSync(
      specPath,
      "# Demo Spec\n\n- Operators can connect Gmail.\n",
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a report + summary when drift is under threshold", async () => {
    writeFileSync(
      path.join(activeDir, "0007-gmail.md"),
      plan({ id: "0007" }),
      "utf8",
    );
    const client = scriptedModelClient([AUDIT_OK]);
    const result = await runFidelityCheck(
      {
        specPath,
        activeDir,
        completedDir,
        reportsDir,
        repoRoot: root,
        now: () => new Date("2026-04-22T10:00:00Z"),
      },
      {
        modelClient: client,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exceedsThreshold).toBe(false);
    expect(existsSync(result.report.markdownPath)).toBe(true);
    expect(existsSync(result.report.summaryPath)).toBe(true);
    expect(result.suspension).toBeNull();
  });

  it("auto-suspends active plans + writes 9999 meta-plan when drift exceeds threshold", async () => {
    writeFileSync(
      path.join(activeDir, "0010-a.md"),
      plan({ id: "0010" }),
      "utf8",
    );
    writeFileSync(
      path.join(activeDir, "0011-b.md"),
      plan({ id: "0011" }),
      "utf8",
    );
    const client = scriptedModelClient([AUDIT_OVER]);
    const result = await runFidelityCheck(
      {
        specPath,
        activeDir,
        completedDir,
        reportsDir,
        repoRoot: root,
        threshold: 25,
        now: () => new Date("2026-04-22T10:00:00Z"),
      },
      {
        modelClient: client,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exceedsThreshold).toBe(true);
    expect(result.suspension).not.toBeNull();
    expect(result.suspension!.blockedPlanIds.sort()).toEqual(["0010", "0011"]);

    // Meta-plan exists and has the expected id.
    const metaPath = path.join(activeDir, "9999-fidelity-review.md");
    expect(existsSync(metaPath)).toBe(true);
    expect(readFileSync(metaPath, "utf8")).toContain('id: "9999"');

    // Both active plans were flipped to blocked.
    for (const id of ["0010", "0011"]) {
      const text = readFileSync(
        path.join(activeDir, `${id}-${id === "0010" ? "a" : "b"}.md`),
        "utf8",
      );
      expect(text).toContain('status: "blocked"');
    }
  });

  it("does not auto-suspend when the caller sets autoSuspend: false", async () => {
    writeFileSync(
      path.join(activeDir, "0010-a.md"),
      plan({ id: "0010" }),
      "utf8",
    );
    const client = scriptedModelClient([AUDIT_OVER]);
    const result = await runFidelityCheck(
      {
        specPath,
        activeDir,
        completedDir,
        reportsDir,
        repoRoot: root,
        threshold: 25,
        autoSuspend: false,
        now: () => new Date("2026-04-22T10:00:00Z"),
      },
      {
        modelClient: client,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exceedsThreshold).toBe(true);
    expect(result.suspension).toBeNull();
    // Plan still active.
    const text = readFileSync(path.join(activeDir, "0010-a.md"), "utf8");
    expect(text).toContain('status: "active"');
    // 9999 meta-plan NOT created.
    expect(existsSync(path.join(activeDir, "9999-fidelity-review.md"))).toBe(
      false,
    );
  });

  it("surfaces a context failure without calling the LLM", async () => {
    const client = scriptedModelClient(["{}"]);
    const result = await runFidelityCheck(
      {
        specPath: path.join(root, "missing.md"),
        activeDir,
        completedDir,
        reportsDir,
        repoRoot: root,
      },
      { modelClient: client },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("context");
    }
    expect(client.calls).toHaveLength(0);
  });
});
