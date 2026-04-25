import {
  chmodSync,
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
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Plan } from "@fork-and-go/plan-graph";

import { composePlanFile, emit, previewEmit, type EmitInput } from "./emit.ts";
import type { PlanProposal } from "./schemas.ts";

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    id: "0100",
    slug: "example-plan",
    title: "Example Plan",
    phase: "Harness",
    depends_on: [],
    estimated_passes: 2,
    summary: "Summary.",
    scope_bullets: ["Bullet"],
    ...overrides,
  };
}

const VALID_BODY = [
  "# 0100 Example Plan",
  "",
  "## Goal",
  "Ship it.",
  "",
  "## Why Now",
  "Now.",
  "",
  "## Scope",
  "- A thing",
  "",
  "## Out Of Scope",
  "- Nothing else",
  "",
  "## Milestones",
  "1. Done",
  "",
  "## Validation",
  "- green",
  "",
  "## Open Questions",
  "- None",
  "",
  "## Decision Log",
  "- 2026-04-22: start",
].join("\n");

function existingPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "0001",
    title: "Base",
    phase: "Foundation",
    status: "completed",
    dependsOn: [],
    estimatedPasses: 1,
    acceptanceTags: [],
    location: "completed",
    filePath: `/virtual/0001-base.md`,
    body: "",
    raw: {
      id: "0001",
      title: "Base",
      phase: "Foundation",
      status: "completed",
      depends_on: [],
      estimated_passes: 1,
      acceptance_tags: [],
    },
    ...overrides,
  };
}

describe("composePlanFile", () => {
  it("prepends the frontmatter with status=active", () => {
    const text = composePlanFile(proposal(), VALID_BODY);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/status:\s*active/u);
    expect(text).toMatch(/id:\s*"?0100"?/u);
    expect(text).toContain("# 0100 Example Plan");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips depends_on arrays", () => {
    const text = composePlanFile(
      proposal({ depends_on: ["0001", "0002"] }),
      VALID_BODY,
    );
    expect(text).toMatch(/depends_on:/u);
    expect(text).toContain('- "0001"');
    expect(text).toContain('- "0002"');
  });
});

describe("emit", () => {
  let root: string;
  let activeDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "planner-emit-"));
    activeDir = path.join(root, "active");
    mkdirSync(activeDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes files atomically when the graph is valid", () => {
    const inputs: EmitInput[] = [
      { proposal: proposal({ id: "0100" }), body: VALID_BODY },
      {
        proposal: proposal({
          id: "0101",
          slug: "second-plan",
          depends_on: ["0100"],
        }),
        body: VALID_BODY.replace("0100", "0101"),
      },
    ];
    const result = emit(inputs, { activeDir, existingPlans: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.written).toHaveLength(2);
      for (const w of result.written) {
        expect(existsSync(w.filePath)).toBe(true);
      }
    }
  });

  it("refuses to overwrite existing files", () => {
    const targetPath = path.join(activeDir, "0100-example-plan.md");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(targetPath, "stub");
    const result = emit([{ proposal: proposal(), body: VALID_BODY }], {
      activeDir,
      existingPlans: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("path-collision");
    // File was not overwritten
    expect(readFileSync(targetPath, "utf8")).toBe("stub");
  });

  it("refuses to write when proposals create a cycle", () => {
    const result = emit(
      [
        {
          proposal: proposal({ id: "0100", depends_on: ["0101"] }),
          body: VALID_BODY,
        },
        {
          proposal: proposal({
            id: "0101",
            slug: "second-plan",
            depends_on: ["0100"],
          }),
          body: VALID_BODY.replace("0100", "0101"),
        },
      ],
      { activeDir, existingPlans: [] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("graph-invalid");
    // No files written
    expect(existsSync(path.join(activeDir, "0100-example-plan.md"))).toBe(
      false,
    );
    expect(existsSync(path.join(activeDir, "0101-second-plan.md"))).toBe(false);
  });

  it("refuses to write when a proposal references a missing dependency", () => {
    const result = emit(
      [
        {
          proposal: proposal({ id: "0100", depends_on: ["0099"] }),
          body: VALID_BODY,
        },
      ],
      { activeDir, existingPlans: [] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("graph-invalid");
  });

  it("validates against the existing plan graph", () => {
    const result = emit(
      [
        {
          proposal: proposal({ id: "0100", depends_on: ["0001"] }),
          body: VALID_BODY,
        },
      ],
      { activeDir, existingPlans: [existingPlan({ id: "0001" })] },
    );
    expect(result.ok).toBe(true);
  });

  it("leaves no .tmp-* staging files behind on success", () => {
    const result = emit(
      [
        { proposal: proposal({ id: "0100" }), body: VALID_BODY },
        {
          proposal: proposal({
            id: "0101",
            slug: "second-plan",
            depends_on: ["0100"],
          }),
          body: VALID_BODY.replace("0100", "0101"),
        },
      ],
      { activeDir, existingPlans: [] },
    );
    expect(result.ok).toBe(true);
    const entries = readdirSync(activeDir);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(entries.sort()).toEqual([
      "0100-example-plan.md",
      "0101-second-plan.md",
    ]);
  });

  it("returns io-error and leaves no files when staging a write fails", () => {
    // chmod the active dir to read-only, forcing writeFileSync to fail
    // during the staging phase. Atomicity means no plan files (and no stray
    // .tmp-* files) should be left behind. Skipped when running as root,
    // where the mode is ignored.
    if (process.getuid?.() === 0) return;
    chmodSync(activeDir, 0o555);
    try {
      const result = emit(
        [
          { proposal: proposal({ id: "0100" }), body: VALID_BODY },
          {
            proposal: proposal({
              id: "0101",
              slug: "second-plan",
              depends_on: ["0100"],
            }),
            body: VALID_BODY.replace("0100", "0101"),
          },
        ],
        { activeDir, existingPlans: [] },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("io-error");
    } finally {
      // Restore perms so the tmpdir teardown can remove the directory.
      chmodSync(activeDir, 0o755);
    }
    const entries = readdirSync(activeDir);
    expect(entries).toEqual([]);
  });
});

describe("previewEmit", () => {
  let root: string;
  let activeDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "planner-preview-"));
    activeDir = path.join(root, "active");
    mkdirSync(activeDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not touch the filesystem", () => {
    const result = previewEmit([{ proposal: proposal(), body: VALID_BODY }], {
      activeDir,
      existingPlans: [],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(activeDir, "0100-example-plan.md"))).toBe(
      false,
    );
  });
});
