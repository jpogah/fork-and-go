import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  containsRateLimitMarker,
  RATE_LIMIT_MARKER,
  RATE_LIMIT_REGEX,
  scanLogForRateLimit,
  tailReason,
} from "./rate-limit-detector.ts";

describe("containsRateLimitMarker", () => {
  it("matches the canonical Claude phrase", () => {
    expect(
      containsRateLimitMarker("You've hit your limit · resets at 5 AM"),
    ).toBe(true);
  });

  it("is case-insensitive on the canonical phrase", () => {
    expect(containsRateLimitMarker("HIT YOUR LIMIT")).toBe(true);
  });

  it("matches OpenAI quota-exceeded variants", () => {
    expect(
      containsRateLimitMarker(
        "Error: You exceeded your current quota, please check your plan and billing.",
      ),
    ).toBe(true);
  });

  it("matches the gateway 'rate limit reached' variant", () => {
    expect(
      containsRateLimitMarker(
        "429 Too Many Requests — rate limit reached for gpt-5.4-mini",
      ),
    ).toBe(true);
  });

  it("matches the OpenAI rate_limit_exceeded error code", () => {
    expect(
      containsRateLimitMarker('{"error":{"code":"rate_limit_exceeded"}}'),
    ).toBe(true);
  });

  it("does NOT match unrelated 'limit' references", () => {
    // Guard against overmatching: diagnostic text that merely mentions the
    // word "limit" must not trigger a rate-limit exit. This is the whole
    // reason we narrowed the regex past a bare `/limit/`.
    expect(
      containsRateLimitMarker("pagination limit reached in the test case"),
    ).toBe(false);
    expect(
      containsRateLimitMarker("off-by-one bug; test hit the length cap."),
    ).toBe(false);
  });

  it("returns false when no marker is present", () => {
    expect(containsRateLimitMarker("all good\nexit 0")).toBe(false);
  });

  it("accepts an explicit marker list that bypasses the regex", () => {
    expect(containsRateLimitMarker("custom marker appears", ["marker"])).toBe(
      true,
    );
    expect(containsRateLimitMarker("no relevant text", ["marker"])).toBe(false);
  });

  it("exports the regex covering all observed variants", () => {
    expect(RATE_LIMIT_REGEX.test("hit your limit")).toBe(true);
    expect(RATE_LIMIT_REGEX.test("rate limit reached")).toBe(true);
    expect(RATE_LIMIT_REGEX.test("rate_limit_exceeded")).toBe(true);
  });
});

describe("scanLogForRateLimit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-budget-rl-"));

  it("scans only the trailing bytes of a large file", () => {
    const file = path.join(dir, "rl-1.log");
    const preamble = "x".repeat(200_000);
    writeFileSync(
      file,
      `${preamble}\nYou've ${RATE_LIMIT_MARKER}. Reset 3am.\n`,
    );
    expect(scanLogForRateLimit(file)).toBe(true);
  });

  it("returns false for non-matching logs", () => {
    const file = path.join(dir, "rl-2.log");
    writeFileSync(file, "all good\nexit 0\n");
    expect(scanLogForRateLimit(file)).toBe(false);
  });

  it("returns false for an empty or missing file", () => {
    const missing = path.join(dir, "never.log");
    expect(scanLogForRateLimit(missing)).toBe(false);
    const empty = path.join(dir, "empty.log");
    writeFileSync(empty, "");
    expect(scanLogForRateLimit(empty)).toBe(false);
  });

  it("catches the marker even when it appears in the final line", () => {
    const file = path.join(dir, "rl-3.log");
    writeFileSync(file, "some log\nrate_limit_exceeded");
    expect(scanLogForRateLimit(file)).toBe(true);
  });
});

describe("tailReason", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-budget-reason-"));

  it("returns the last few non-empty lines", () => {
    const file = path.join(dir, "reason-1.log");
    writeFileSync(
      file,
      ["noise", "", "first finding", "second finding", "", "last line"].join(
        "\n",
      ),
    );
    const reason = tailReason(file, 2);
    expect(reason).toContain("last line");
    expect(reason).toContain("second finding");
  });

  it("falls back to a placeholder on missing logs", () => {
    expect(tailReason(path.join(dir, "missing.log"))).toMatch(/no log/);
  });

  it("truncates a very long tail to the max length", () => {
    const file = path.join(dir, "reason-2.log");
    const longLine = "a".repeat(900);
    writeFileSync(file, `header\n${longLine}\n`);
    const reason = tailReason(file, 2, 600);
    expect(reason.length).toBeLessThanOrEqual(600);
  });
});
