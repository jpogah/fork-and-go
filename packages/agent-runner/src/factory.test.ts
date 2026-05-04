import { describe, expect, it } from "vitest";

import { createAgentRunner } from "./factory.ts";

describe("createAgentRunner", () => {
  it("returns a runner with all three modes for claude", () => {
    const runner = createAgentRunner({ provider: "claude" });
    expect(typeof runner.exec).toBe("function");
    expect(typeof runner.review).toBe("function");
    expect(typeof runner.complete).toBe("function");
  });

  it("returns a runner with all three modes for codex", () => {
    const runner = createAgentRunner({ provider: "codex" });
    expect(typeof runner.exec).toBe("function");
    expect(typeof runner.review).toBe("function");
    expect(typeof runner.complete).toBe("function");
  });

  it("rejects an unknown provider at runtime", () => {
    expect(() =>
      createAgentRunner({
        provider: "grok" as unknown as "claude",
      }),
    ).toThrow(/unknown agent provider/);
  });
});
