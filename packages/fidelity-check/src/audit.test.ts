import { describe, expect, it } from "vitest";

import { audit } from "./audit.ts";
import type { FidelityContext } from "./context-builder.ts";
import { scriptedModelClient } from "./testing.ts";

function ctx(overrides: Partial<FidelityContext> = {}): FidelityContext {
  return {
    spec: {
      path: "/virtual/spec.md",
      slug: "spec",
      content: "# Spec\n\nDo a thing.",
    },
    plans: [
      {
        id: "0010",
        title: "Alpha",
        phase: "Harness",
        status: "active",
        location: "active",
        dependsOn: [],
        acceptanceTags: [],
        blurb: "alpha",
      },
    ],
    repoSlice: {
      appFiles: [],
      packageFiles: [],
      apiRoutes: [],
      testFiles: [],
    },
    previousSummary: null,
    repoRoot: "/virtual",
    ...overrides,
  };
}

const VALID = JSON.stringify({
  risk_score: 20,
  requirements: [
    {
      requirement: "Do a thing.",
      status: "met",
      plan_id: "0010",
      notes: "",
    },
  ],
  drift: [],
  risks: [],
  recommended_actions: [],
});

describe("audit", () => {
  it("accepts a valid first response", async () => {
    const client = scriptedModelClient([VALID]);
    const result = await audit(ctx(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.risk_score).toBe(20);
      expect(result.output.requirements).toHaveLength(1);
      expect(result.attempts).toHaveLength(1);
      expect(client.calls[0]?.model).toBe("mini");
    }
  });

  it("repairs a malformed response then succeeds", async () => {
    const client = scriptedModelClient(["not json at all", VALID]);
    const result = await audit(ctx(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.ok).toBe(false);
      expect(result.attempts[1]?.ok).toBe(true);
      expect(client.calls[1]?.model).toBe("full");
    }
  });

  it("hard-fails after max repair attempts", async () => {
    const client = scriptedModelClient(["not json", "still not json"]);
    const result = await audit(ctx(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.reason).toContain("audit phase failed");
    }
  });

  it("fences the spec in the user message", async () => {
    const client = scriptedModelClient([VALID]);
    await audit(ctx(), {
      modelClient: client,
      systemPrompt: "SYSTEM",
      defaultModel: "mini",
      repairModel: "full",
    });
    const content = client.calls[0]?.messages[0]?.content ?? "";
    expect(content).toContain("<<<SPEC_BEGIN>>>");
    expect(content).toContain("<<<SPEC_END>>>");
  });
});
