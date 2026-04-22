import { describe, expect, it } from "vitest";

import { createMergeDetector, type MergedPr } from "./merge-detector.ts";

function pr(overrides: Partial<MergedPr>): MergedPr {
  return {
    number: 1,
    title: "t",
    headRefName: "task/x",
    mergeCommit: "sha",
    mergedAt: "2026-04-22T00:00:00Z",
    ...overrides,
  };
}

describe("merge detector", () => {
  it("returns nothing when there are no merges", async () => {
    const detector = createMergeDetector({
      fetchMerged: async () => [],
    });
    const result = await detector.poll(null);
    expect(result.merges).toEqual([]);
    expect(result.latestSha).toBeNull();
  });

  it("returns new merges that post-date the cached sha", async () => {
    const recent = [
      pr({ number: 3, mergeCommit: "c" }),
      pr({ number: 2, mergeCommit: "b" }),
      pr({ number: 1, mergeCommit: "a" }),
    ];
    const detector = createMergeDetector({
      fetchMerged: async () => recent,
    });
    const result = await detector.poll("a");
    expect(result.merges.map((m) => m.pr.number)).toEqual([2, 3]);
    expect(result.latestSha).toBe("c");
  });

  it("dedupes on subsequent polls with the same anchor", async () => {
    const recent = [
      pr({ number: 2, mergeCommit: "b" }),
      pr({ number: 1, mergeCommit: "a" }),
    ];
    const detector = createMergeDetector({
      fetchMerged: async () => recent,
    });
    const first = await detector.poll("a");
    expect(first.merges.map((m) => m.pr.number)).toEqual([2]);
    const second = await detector.poll(first.latestSha);
    expect(second.merges).toEqual([]);
    expect(second.latestSha).toBe("b");
  });

  it("anchors to the newest merge on a cold start", async () => {
    const recent = [
      pr({ number: 2, mergeCommit: "b" }),
      pr({ number: 1, mergeCommit: "a" }),
    ];
    const detector = createMergeDetector({
      fetchMerged: async () => recent,
    });
    const result = await detector.poll(null);
    // Cold start: don't replay the entire window as "new", just remember
    // the newest sha for next tick.
    expect(result.merges).toEqual([]);
    expect(result.latestSha).toBe("b");
  });

  it("handles the anchor scrolling off the window gracefully", async () => {
    const detector = createMergeDetector({
      fetchMerged: async () => [
        pr({ number: 10, mergeCommit: "z" }),
        pr({ number: 9, mergeCommit: "y" }),
      ],
    });
    const result = await detector.poll("gone");
    expect(result.merges).toEqual([]);
    expect(result.latestSha).toBe("z");
  });

  it("filters out PRs without a merge commit", async () => {
    const detector = createMergeDetector({
      fetchMerged: async () => [
        pr({ number: 4, mergeCommit: "d" }),
        pr({ number: 3, mergeCommit: null }),
        pr({ number: 2, mergeCommit: "b" }),
      ],
    });
    const result = await detector.poll("b");
    expect(result.merges.map((m) => m.pr.number)).toEqual([4]);
  });
});
