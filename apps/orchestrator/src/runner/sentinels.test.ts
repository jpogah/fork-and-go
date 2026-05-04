import { describe, expect, it } from "vitest";

import {
  e2eVerificationPassed,
  firstNonEmptyLine,
  mergeIsReady,
  reviewIsClean,
} from "./sentinels.ts";

describe("firstNonEmptyLine", () => {
  it("skips blank lines", () => {
    expect(firstNonEmptyLine("\n\n  \nhello\n")).toBe("hello");
  });
  it("returns empty string when nothing is present", () => {
    expect(firstNonEmptyLine("")).toBe("");
    expect(firstNonEmptyLine("   \n  ")).toBe("");
  });
});

describe("reviewIsClean", () => {
  it("recognizes the sentinel as the first non-empty line", () => {
    expect(reviewIsClean("\nNo findings.\n")).toBe(true);
    expect(reviewIsClean("No blocking findings. Some Lows below.")).toBe(true);
  });
  it("recognizes the sentinel embedded later as a standalone line", () => {
    expect(
      reviewIsClean(
        "Quick preamble line.\n\nNo findings.\n\nrest of the body here",
      ),
    ).toBe(true);
  });
  it("rejects findings reports", () => {
    expect(reviewIsClean("### Critical\nSomething broken")).toBe(false);
    expect(reviewIsClean("")).toBe(false);
  });
});

describe("mergeIsReady", () => {
  it("recognizes the merge sentinel", () => {
    expect(mergeIsReady("No findings. Ready to enable auto-merge.")).toBe(true);
  });
  it("rejects review sentinel for merge", () => {
    expect(mergeIsReady("No findings.")).toBe(false);
  });
});

describe("e2eVerificationPassed", () => {
  it("requires the exact sentinel as the first line", () => {
    expect(e2eVerificationPassed("E2E verification passed.\n\nartifacts: ...")).toBe(true);
    expect(e2eVerificationPassed("E2E verification failed.")).toBe(false);
  });
});
