import { describe, expect, it } from "vitest";

import { FALLBACK_RATE, estimateCostCents, rateFor } from "./pricing.ts";

describe("rateFor", () => {
  it("matches Claude opus", () => {
    expect(rateFor("claude-opus-4-7").model).toBe("claude-opus");
  });

  it("matches Claude sonnet", () => {
    expect(rateFor("claude-sonnet-4-6").model).toBe("claude-sonnet");
  });

  it("matches GPT-5.4 mini", () => {
    expect(rateFor("gpt-5.4-mini").model).toBe("gpt-5.4-mini");
  });

  it("falls back to the conservative rate on unknown models", () => {
    const rate = rateFor("experimental-unknown-model");
    expect(rate).toEqual(FALLBACK_RATE);
  });

  it("matches the most specific entry first (mini beats the bare family)", () => {
    // `gpt-5.4-mini` must not collide with `gpt-5.4` — order of the rate card
    // is load-bearing, and this test fails if someone reorders it.
    expect(rateFor("gpt-5.4-mini").model).toBe("gpt-5.4-mini");
    expect(rateFor("gpt-5.4-mini").inputCentsPerMTok).toBe(25);
  });
});

describe("estimateCostCents", () => {
  it("computes cents for a claude-opus invocation", () => {
    const cost = estimateCostCents("claude-opus-4-7", {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
    });
    // 1M * 1500 = 1500 cents input; 0.2M * 7500 = 1500 cents output
    expect(cost).toBeCloseTo(3000, 0);
  });

  it("computes cents for a gpt-5.4-mini invocation", () => {
    const cost = estimateCostCents("gpt-5.4-mini", {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    // 25 cents input + 100 cents output = 125
    expect(cost).toBeCloseTo(125, 0);
  });

  it("is zero for zero usage", () => {
    expect(
      estimateCostCents("claude-opus", { inputTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });
});
