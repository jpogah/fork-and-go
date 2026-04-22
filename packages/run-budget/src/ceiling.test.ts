import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyDelta,
  BUDGET_FILE_VERSION,
  DEFAULT_TOKEN_CEILING,
  DEFAULT_WINDOW_MS,
  emptyBudget,
  isCeilingReached,
  loadBudget,
  saveBudget,
  withCeiling,
} from "./ceiling.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "run-budget-ceiling-"));
}

describe("emptyBudget", () => {
  it("defaults to 5M tokens and a 7-day window", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const b = emptyBudget({ now });
    expect(b.tokenCeiling).toBe(DEFAULT_TOKEN_CEILING);
    expect(b.tokensUsed).toBe(0);
    expect(b.costCentsEstimated).toBe(0);
    expect(Date.parse(b.resetAt) - now.getTime()).toBe(DEFAULT_WINDOW_MS);
  });
});

describe("loadBudget", () => {
  it("creates a fresh file when none exists", () => {
    const dir = freshDir();
    const now = new Date("2026-04-22T12:00:00Z");
    const b = loadBudget({ dir, now: () => now });
    expect(b.tokensUsed).toBe(0);
    expect(existsSync(path.join(dir, "budget.json"))).toBe(true);
  });

  it("honors a custom ceiling on first write", () => {
    const dir = freshDir();
    const b = loadBudget({ dir, defaultCeiling: 1000 });
    expect(b.tokenCeiling).toBe(1000);
  });

  it("reads an existing file unchanged", () => {
    const dir = freshDir();
    const now = new Date("2026-04-22T12:00:00Z");
    const first = loadBudget({ dir, defaultCeiling: 9999, now: () => now });
    const updated = applyDelta(first, { tokens: 500, costCents: 10 }, now);
    saveBudget(dir, updated);
    const reread = loadBudget({ dir, defaultCeiling: 12345, now: () => now });
    expect(reread.tokenCeiling).toBe(9999);
    expect(reread.tokensUsed).toBe(500);
  });

  it("rolls the window and zeros counters after resetAt passes", () => {
    const dir = freshDir();
    const past = new Date("2026-03-01T00:00:00Z");
    const first = loadBudget({ dir, now: () => past });
    const withUsage = applyDelta(first, { tokens: 2000, costCents: 50 }, past);
    saveBudget(dir, withUsage);

    const future = new Date(past.getTime() + DEFAULT_WINDOW_MS + 60_000);
    const rolled = loadBudget({ dir, now: () => future });
    expect(rolled.tokensUsed).toBe(0);
    expect(rolled.costCentsEstimated).toBe(0);
    expect(Date.parse(rolled.resetAt)).toBeGreaterThan(future.getTime());
    // Ceiling must survive the roll.
    expect(rolled.tokenCeiling).toBe(DEFAULT_TOKEN_CEILING);
  });

  it("throws on a version mismatch", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "budget.json"),
      JSON.stringify({ version: 99 }),
      "utf8",
    );
    expect(() => loadBudget({ dir })).toThrow(/version mismatch/);
  });
});

describe("applyDelta + isCeilingReached", () => {
  it("accumulates tokens and cost", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    let b = emptyBudget({ ceiling: 1000, now });
    b = applyDelta(b, { tokens: 400, costCents: 5.25 }, now);
    b = applyDelta(b, { tokens: 400, costCents: 4.75 }, now);
    expect(b.tokensUsed).toBe(800);
    expect(b.costCentsEstimated).toBeCloseTo(10, 2);
    expect(isCeilingReached(b)).toBe(false);
  });

  it("flips to ceiling-reached when crossing the threshold", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    let b = emptyBudget({ ceiling: 500, now });
    b = applyDelta(b, { tokens: 600, costCents: 0 }, now);
    expect(isCeilingReached(b)).toBe(true);
  });
});

describe("withCeiling", () => {
  it("raises the ceiling without touching usage", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const b = emptyBudget({ ceiling: 1000, now });
    const withUsage = applyDelta(b, { tokens: 900, costCents: 2 }, now);
    const raised = withCeiling(withUsage, 5_000_000, now);
    expect(raised.tokenCeiling).toBe(5_000_000);
    expect(raised.tokensUsed).toBe(900);
  });

  it("rejects non-positive ceilings", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const b = emptyBudget({ now });
    expect(() => withCeiling(b, 0, now)).toThrow(/positive/);
    expect(() => withCeiling(b, -1, now)).toThrow(/positive/);
    expect(() => withCeiling(b, Number.NaN, now)).toThrow(/positive/);
  });
});

describe("saveBudget", () => {
  it("writes the current version and is readable by loadBudget", () => {
    const dir = freshDir();
    const now = new Date("2026-04-22T12:00:00Z");
    const b = emptyBudget({ ceiling: 123, now });
    saveBudget(dir, b);
    const read = JSON.parse(
      readFileSync(path.join(dir, "budget.json"), "utf8"),
    );
    expect(read.version).toBe(BUDGET_FILE_VERSION);
    expect(read.tokenCeiling).toBe(123);
    const reloaded = loadBudget({ dir, now: () => now });
    expect(reloaded.tokenCeiling).toBe(123);
  });
});
