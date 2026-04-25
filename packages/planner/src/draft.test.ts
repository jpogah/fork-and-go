import { describe, expect, it } from "vitest";

import { draftPlanBody, REQUIRED_SECTIONS } from "./draft.ts";
import type { PlanProposal } from "./schemas.ts";
import { scriptedModelClient } from "./testing.ts";

function proposal(): PlanProposal {
  return {
    id: "0100",
    slug: "example-plan",
    title: "Example Plan",
    phase: "Harness",
    depends_on: [],
    estimated_passes: 2,
    summary: "Ship it.",
    scope_bullets: ["Do a thing."],
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
  "- Do a thing.",
  "",
  "## Out Of Scope",
  "- Nothing else.",
  "",
  "## Milestones",
  "1. Write code.",
  "",
  "## Validation",
  "- green",
  "",
  "## Open Questions",
  "- None at this time.",
  "",
  "## Decision Log",
  "- 2026-04-22: start",
].join("\n");

describe("draftPlanBody", () => {
  it("accepts a valid plain-markdown draft", async () => {
    const client = scriptedModelClient([VALID_BODY]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toContain("# 0100 Example Plan");
      expect(result.attempts).toHaveLength(1);
    }
  });

  it("accepts a JSON-wrapped { body: '...' } draft", async () => {
    const client = scriptedModelClient([JSON.stringify({ body: VALID_BODY })]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
  });

  it("repairs a JSON object that uses an alternative field name", async () => {
    // The model might put the markdown under `content` or `markdown` when
    // reminded of JSON-mode. The parser must surface a clear error so the
    // repair round can correct the shape instead of feeding raw JSON text
    // through to the heading check.
    const wrongShape = JSON.stringify({ content: VALID_BODY });
    const client = scriptedModelClient([
      wrongShape,
      JSON.stringify({ body: VALID_BODY }),
    ]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]!.ok).toBe(false);
      expect(result.attempts[0]!.error).toMatch(/body/u);
    }
  });

  it("repairs a draft missing a required heading", async () => {
    const bodyMissingValidation = VALID_BODY.replace(
      "## Validation\n- green\n\n",
      "",
    );
    const client = scriptedModelClient([bodyMissingValidation, VALID_BODY]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toHaveLength(2);
  });

  it("rejects a draft that begins with YAML frontmatter", async () => {
    const withFm = `---\nid: "0100"\n---\n\n${VALID_BODY}`;
    const client = scriptedModelClient([withFm, withFm]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
      maxRepairAttempts: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/frontmatter/u);
  });

  it("terminates after max repair attempts on persistently bad drafts", async () => {
    const client = scriptedModelClient([""]);
    const result = await draftPlanBody(proposal(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBeLessThanOrEqual(2);
  });

  it("requires every canonical section heading", () => {
    expect(REQUIRED_SECTIONS).toContain("## Goal");
    expect(REQUIRED_SECTIONS).toContain("## Decision Log");
  });
});
