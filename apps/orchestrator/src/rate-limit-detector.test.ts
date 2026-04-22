import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  containsRateLimitMarker,
  RATE_LIMIT_MARKER,
  scanLogForRateLimit,
  tailReason,
} from "./rate-limit-detector.ts";

describe("containsRateLimitMarker", () => {
  it("matches the canonical phrase", () => {
    expect(
      containsRateLimitMarker("You've hit your limit · resets at 5 AM"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(containsRateLimitMarker("HIT YOUR LIMIT")).toBe(true);
  });

  it("returns false when the phrase is absent", () => {
    expect(containsRateLimitMarker("some other error")).toBe(false);
  });
});

describe("scanLogForRateLimit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orchestrator-rl-"));

  it("scans the trailing bytes of a file", () => {
    const file = path.join(dir, "rl-1.log");
    const preamble = "x".repeat(10_000);
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

  it("returns false when the file does not exist", () => {
    expect(scanLogForRateLimit(path.join(dir, "never.log"))).toBe(false);
  });
});

describe("tailReason", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orchestrator-reason-"));

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
});
