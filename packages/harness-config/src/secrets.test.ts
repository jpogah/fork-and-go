import { describe, expect, it } from "vitest";

import {
  composeSecretsProviders,
  createEnvSecretsProvider,
  createMemorySecretsProvider,
} from "./secrets.ts";

describe("env secrets provider", () => {
  it("reads from the supplied env map", () => {
    const p = createEnvSecretsProvider({ ANTHROPIC_API_KEY: "k" });
    expect(p.get("ANTHROPIC_API_KEY")).toBe("k");
    expect(p.get("OPENAI_API_KEY")).toBeUndefined();
  });
});

describe("memory secrets provider", () => {
  it("returns configured values", () => {
    const p = createMemorySecretsProvider({ FOO: "bar" });
    expect(p.get("FOO")).toBe("bar");
  });
});

describe("composeSecretsProviders", () => {
  it("returns the first hit", async () => {
    const a = createMemorySecretsProvider({ A: "1" });
    const b = createMemorySecretsProvider({ A: "2", B: "3" });
    const composed = composeSecretsProviders(a, b);
    expect(await composed.get("A")).toBe("1");
    expect(await composed.get("B")).toBe("3");
    expect(await composed.get("MISSING")).toBeUndefined();
  });

  it("awaits async providers", async () => {
    const slow = {
      async get(name: string) {
        await new Promise((r) => setTimeout(r, 1));
        return name === "X" ? "slow-x" : undefined;
      },
    };
    const fast = createMemorySecretsProvider({ Y: "fast-y" });
    const composed = composeSecretsProviders(slow, fast);
    expect(await composed.get("X")).toBe("slow-x");
    expect(await composed.get("Y")).toBe("fast-y");
  });
});
