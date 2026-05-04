import { describe, expect, it, vi } from "vitest";

import { wrapAgentAsCompletionClient } from "./completion.ts";
import type { AgentRunner } from "./types.ts";

function stubRunner(message: string): AgentRunner {
  const complete = vi.fn(async () => ({
    message,
    tokensUsed: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 1.5,
    },
    ok: true,
  }));
  return {
    exec: vi.fn(),
    review: vi.fn(),
    complete,
  } as unknown as AgentRunner;
}

describe("wrapAgentAsCompletionClient", () => {
  it("forwards system prompt and a single user message as the prompt", async () => {
    const runner = stubRunner('{"ok":true}');
    const client = wrapAgentAsCompletionClient(runner, { cwd: "/tmp" });
    const response = await client.complete({
      system: "you are a planner",
      messages: [{ role: "user", content: "decompose this spec" }],
      model: "claude-sonnet-4-6",
    });
    expect(response.text).toBe('{"ok":true}');
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(20);
    expect(response.usage.costCents).toBe(1.5);
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(runner.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "decompose this spec",
        cwd: "/tmp",
        systemPrompt: "you are a planner",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("flattens multi-turn transcripts (planner repair pattern)", async () => {
    const runner = stubRunner('{"fixed":true}');
    const client = wrapAgentAsCompletionClient(runner, { cwd: "/tmp" });
    await client.complete({
      system: "you are a planner",
      messages: [
        { role: "user", content: "first attempt" },
        { role: "assistant", content: "bad json" },
        { role: "user", content: "fix it" },
      ],
    });
    const call = (runner.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.prompt).toContain("### USER");
    expect(call.prompt).toContain("first attempt");
    expect(call.prompt).toContain("### ASSISTANT");
    expect(call.prompt).toContain("bad json");
    expect(call.prompt).toContain("fix it");
  });
});
