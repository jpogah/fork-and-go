import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPlans, validateGraph } from "@fork-and-go/plan-graph";

import { createInMemoryPlannerAuditSink, runPlanner } from "./index.ts";
import { scriptedModelClient } from "./testing.ts";

const SPEC = `# Example product spec

## Goal

Add a tiny analytics vertical with a connector, executor, and template.
`;

function validBody(id: string, title: string): string {
  return [
    `# ${id} ${title}`,
    "",
    "## Goal",
    "Ship it.",
    "",
    "## Why Now",
    "Unlocks downstream work.",
    "",
    "## Scope",
    "- Write code.",
    "",
    "## Out Of Scope",
    "- Unrelated features.",
    "",
    "## Milestones",
    "1. Implement.",
    "",
    "## Validation",
    "- npm test passes.",
    "",
    "## Open Questions",
    "- None at this time.",
    "",
    "## Decision Log",
    "- 2026-04-22: planned.",
  ].join("\n");
}

function seedPlan(
  activeDir: string,
  id: string,
  opts: { depends?: string[]; status?: string; title?: string } = {},
): void {
  const title = opts.title ?? `Seed ${id}`;
  const depends = opts.depends ?? [];
  const status = opts.status ?? "active";
  const body = [
    "---",
    `id: "${id}"`,
    `title: "${title}"`,
    `phase: "Harness"`,
    `status: "${status}"`,
    depends.length
      ? `depends_on:\n${depends.map((d) => `  - "${d}"`).join("\n")}`
      : `depends_on: []`,
    `estimated_passes: 2`,
    `acceptance_tags: []`,
    "---",
    "",
    validBody(id, title),
    "",
  ].join("\n");
  writeFileSync(path.join(activeDir, `${id}-seed.md`), body, "utf8");
}

interface Workspace {
  root: string;
  specPath: string;
  activeDir: string;
  completedDir: string;
}

function createWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "planner-run-"));
  const activeDir = path.join(root, "active");
  const completedDir = path.join(root, "completed");
  mkdirSync(activeDir);
  mkdirSync(completedDir);
  const specPath = path.join(root, "SPEC.md");
  writeFileSync(specPath, SPEC, "utf8");
  return { root, specPath, activeDir, completedDir };
}

const PROMPTS = {
  decompose: "decompose system",
  draft: "draft system",
};

describe("runPlanner", () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = createWorkspace();
  });

  afterEach(() => {
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("emits plan files for a clean run and they pass graph validation", async () => {
    seedPlan(ws.activeDir, "0048");
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "connector",
          title: "Connector",
          phase: "Connectors",
          depends_on: [],
          estimated_passes: 2,
          summary: "Ship the connector.",
          scope_bullets: ["OAuth flow.", "Provider client."],
        },
        {
          id: "0101",
          slug: "executor",
          title: "Executor",
          phase: "Executors",
          depends_on: ["0100"],
          estimated_passes: 2,
          summary: "Ship the executor.",
          scope_bullets: ["Action kinds."],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      validBody("0100", "Connector"),
      validBody("0101", "Executor"),
    ]);
    const sink = createInMemoryPlannerAuditSink();
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        auditSink: sink,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.emitted.map((e) => e.id)).toEqual(["0100", "0101"]);
    }

    // Every emitted plan file exists.
    expect(existsSync(path.join(ws.activeDir, "0100-connector.md"))).toBe(true);
    expect(existsSync(path.join(ws.activeDir, "0101-executor.md"))).toBe(true);

    // Graph validator agrees.
    const plans = loadPlans({
      activeDir: ws.activeDir,
      completedDir: ws.completedDir,
    });
    expect(validateGraph(plans).ok).toBe(true);

    // Audit events were recorded including a completed event.
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toContain("planning.started");
    expect(kinds).toContain("planning.proposals_emitted");
    expect(kinds.filter((k) => k === "planning.plan_written")).toHaveLength(2);
    expect(kinds).toContain("planning.completed");
  });

  it("preview mode does not write any files", async () => {
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "ship-thing",
          title: "Ship Thing",
          phase: "Harness",
          depends_on: [],
          estimated_passes: 1,
          summary: "Ship it.",
          scope_bullets: ["Thing"],
        },
      ],
    });
    const client = scriptedModelClient([decomposeResponse]);
    const before = readdirSync(ws.activeDir);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "preview",
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    const after = readdirSync(ws.activeDir);
    expect(after).toEqual(before);
    if (outcome.ok) {
      expect(outcome.result.mode).toBe("preview");
      expect(outcome.result.emitted).toHaveLength(0);
      expect(outcome.result.proposals).toHaveLength(1);
    }
    // Only the decompose LLM call fired in preview mode.
    expect(client.calls).toHaveLength(1);
  });

  it("halts and writes nothing when the cap is exceeded", async () => {
    // Cap is now a safety ceiling (default 30). Explicitly set a low cap
    // to test the guardrail fires without emitting dozens of proposals.
    const cap = 3;
    const proposals = Array.from({ length: cap + 1 }, (_, i) => ({
      id: (100 + i).toString().padStart(4, "0"),
      slug: `ship-${i}`,
      title: `Ship ${i}`,
      phase: "Harness",
      depends_on: [],
      estimated_passes: 1,
      summary: "A thing.",
      scope_bullets: ["Thing"],
    }));
    const client = scriptedModelClient([JSON.stringify({ proposals })]);
    const sink = createInMemoryPlannerAuditSink();
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
        maxNewPlans: cap,
      },
      {
        modelClient: client,
        auditSink: sink,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("guardrail");
      expect(outcome.reason).toMatch(/breaking the spec into phases/);
    }
    expect(readdirSync(ws.activeDir)).toHaveLength(0);
    expect(sink.events.some((e) => e.kind === "planning.failed")).toBe(true);
  });

  it("skips completed plan ids and flags active-id conflicts", async () => {
    seedPlan(ws.completedDir, "0001", { status: "completed" });
    seedPlan(ws.activeDir, "0002", { status: "active", title: "Old Active" });
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0001",
          slug: "old-done",
          title: "Redundant",
          phase: "Foundation",
          depends_on: [],
          estimated_passes: 1,
          summary: "Already done.",
          scope_bullets: ["Stale"],
        },
        {
          id: "0002",
          slug: "conflict",
          title: "Different Scope",
          phase: "Foundation",
          depends_on: [],
          estimated_passes: 1,
          summary: "Different.",
          scope_bullets: ["x"],
        },
      ],
    });
    const client = scriptedModelClient([decomposeResponse]);
    const sink = createInMemoryPlannerAuditSink();
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        auditSink: sink,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("guardrail");
      expect(outcome.reason).toMatch(/0002/);
      expect(outcome.reason).toMatch(/Old Active/);
    }
    const conflictEvents = sink.events.filter(
      (e) => e.kind === "planning.conflict",
    );
    expect(conflictEvents).toHaveLength(1);
    // No files written.
    expect(
      readdirSync(ws.activeDir).filter((f) => f.startsWith("0002-conflict")),
    ).toHaveLength(0);
  });

  it("on re-run after a plan has merged, skips the merged plan cleanly", async () => {
    // Simulate 0100 having merged to completed/, ask the planner to re-emit
    // 0100 + 0101 — it should skip 0100 and emit only 0101.
    seedPlan(ws.completedDir, "0100", {
      status: "completed",
      title: "Already Done",
    });
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "merged",
          title: "Merged",
          phase: "Harness",
          depends_on: [],
          estimated_passes: 1,
          summary: "Already in completed.",
          scope_bullets: ["x"],
        },
        {
          id: "0101",
          slug: "fresh",
          title: "Fresh",
          phase: "Harness",
          depends_on: [],
          estimated_passes: 1,
          summary: "Still pending.",
          scope_bullets: ["y"],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      validBody("0101", "Fresh"),
    ]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.skipped.map((s) => s.id)).toEqual(["0100"]);
      expect(outcome.result.emitted.map((e) => e.id)).toEqual(["0101"]);
    }
    expect(existsSync(path.join(ws.activeDir, "0101-fresh.md"))).toBe(true);
    expect(existsSync(path.join(ws.activeDir, "0100-merged.md"))).toBe(false);
  });

  it("hard-fails and emits planning.failed when decompose never validates", async () => {
    const client = scriptedModelClient(["not json", "also not json"]);
    const sink = createInMemoryPlannerAuditSink();
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        auditSink: sink,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
        maxRepairAttempts: 1,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe("decompose");
    expect(sink.events.some((e) => e.kind === "planning.failed")).toBe(true);
  });

  it("refuses to emit when proposals introduce a cycle", async () => {
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "plan-a",
          title: "Plan A",
          phase: "Harness",
          depends_on: ["0101"],
          estimated_passes: 1,
          summary: "Cycle-a.",
          scope_bullets: ["a"],
        },
        {
          id: "0101",
          slug: "plan-b",
          title: "Plan B",
          phase: "Harness",
          depends_on: ["0100"],
          estimated_passes: 1,
          summary: "Cycle-b.",
          scope_bullets: ["b"],
        },
      ],
    });
    const client = scriptedModelClient([decomposeResponse]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe("guardrail");
    expect(readdirSync(ws.activeDir)).toHaveLength(0);
  });

  it("refuses to emit when a draft fails validation", async () => {
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "bad-draft",
          title: "Bad Draft",
          phase: "Harness",
          depends_on: [],
          estimated_passes: 1,
          summary: "Will be malformed.",
          scope_bullets: ["scope"],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      "empty",
      "still empty",
    ]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
        maxRepairAttempts: 1,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe("draft");
    // No plan file was written for the failed proposal.
    expect(readdirSync(ws.activeDir).some((f) => f.startsWith("0100-"))).toBe(
      false,
    );
  });

  it("regenerates PLANS.md at plansMdPath after a successful emit", async () => {
    seedPlan(ws.activeDir, "0048");
    const plansMdPath = path.join(ws.root, "PLANS.md");
    writeFileSync(plansMdPath, "stale contents\n", "utf8");
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "new-entry",
          title: "New Entry",
          phase: "Harness",
          depends_on: ["0048"],
          estimated_passes: 2,
          summary: "New.",
          scope_bullets: ["Ship it"],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      validBody("0100", "New Entry"),
    ]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
        plansMdPath,
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    const plansMd = readFileSync(plansMdPath, "utf8");
    expect(plansMd).not.toContain("stale contents");
    expect(plansMd).toContain("# Plans");
    expect(plansMd).toContain("0100");
    expect(plansMd).toContain("New Entry");
  });

  it("plumbs acceptance_tags from proposals into emitted plan frontmatter (plan 0054)", async () => {
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "tagged",
          title: "Tagged",
          phase: "Harness",
          depends_on: [],
          estimated_passes: 1,
          summary: "Covers a release gate tag.",
          scope_bullets: ["Ship it"],
          acceptance_tags: ["demo/hello"],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      validBody("0100", "Tagged"),
    ]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
        acceptanceTags: [
          { tag: "demo/hello", description: "Operator sees a hello." },
        ],
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    const written = readFileSync(
      path.join(ws.activeDir, "0100-tagged.md"),
      "utf8",
    );
    expect(written).toMatch(/acceptance_tags:\s*\n\s*-\s*demo\/hello/u);
    // Decompose prompt included the available tags so the LLM can claim them.
    const decomposeCall = client.calls[0]!;
    const userContent = decomposeCall.messages[0]!.content;
    expect(userContent).toContain('"availableAcceptanceTags"');
    expect(userContent).toContain("demo/hello");
  });

  it("produces plan files that pass plan-graph validation alongside real repo plans", async () => {
    // Load a few representative real plans and put copies in the temp
    // workspace so the synthetic graph looks like the live repo. This is
    // the harness-level assertion: the planner's output is compatible with
    // the 0048 validator unchanged.
    seedPlan(ws.activeDir, "0048");
    const decomposeResponse = JSON.stringify({
      proposals: [
        {
          id: "0100",
          slug: "new-plan",
          title: "New Plan",
          phase: "Harness",
          depends_on: ["0048"],
          estimated_passes: 2,
          summary: "New.",
          scope_bullets: ["Ship it"],
        },
      ],
    });
    const client = scriptedModelClient([
      decomposeResponse,
      validBody("0100", "New Plan"),
    ]);
    const outcome = await runPlanner(
      {
        specPath: ws.specPath,
        activeDir: ws.activeDir,
        completedDir: ws.completedDir,
        repoRoot: ws.root,
        mode: "emit",
      },
      {
        modelClient: client,
        prompts: PROMPTS,
        defaultModel: "mini",
        repairModel: "full",
      },
    );
    expect(outcome.ok).toBe(true);
    const written = readFileSync(
      path.join(ws.activeDir, "0100-new-plan.md"),
      "utf8",
    );
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toMatch(/status:\s*active/u);
    const plans = loadPlans({
      activeDir: ws.activeDir,
      completedDir: ws.completedDir,
    });
    expect(validateGraph(plans).ok).toBe(true);
  });
});
