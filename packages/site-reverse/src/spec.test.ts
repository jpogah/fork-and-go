import { describe, expect, it } from "vitest";

import { renderProductSpec, renderSourceAnalysisMarkdown } from "./spec.ts";
import type { SiteAnalysis, SiteCapture } from "./types.ts";

describe("spec rendering", () => {
  it("renders a planner-ready spec with rebuild guardrails", () => {
    const spec = renderProductSpec({
      slug: "video-tool",
      capture: sampleCapture(),
      analysis: sampleAnalysis(),
    });

    expect(spec).toContain("# Better Video Tool Rebuild");
    expect(spec).toContain("## Acceptance Criteria");
    expect(spec).toContain("Do not copy proprietary source");
    expect(spec).toContain("[must] Upload media");
  });

  it("renders a planner-scoped context drop", () => {
    const markdown = renderSourceAnalysisMarkdown({
      slug: "video-tool",
      capture: sampleCapture(),
      analysis: sampleAnalysis(),
    });

    expect(markdown).toContain("scope: planner");
    expect(markdown).toContain("docs/context/site-reverse/video-tool/");
  });
});

function sampleCapture(): SiteCapture {
  return {
    sourceUrl: "https://example.com/",
    normalizedSourceUrl: "https://example.com/",
    origin: "https://example.com",
    capturedAt: "2026-04-25T00:00:00.000Z",
    maxPages: 1,
    viewports: ["desktop"],
    pages: [],
  };
}

function sampleAnalysis(): SiteAnalysis {
  return {
    appName: "Better Video Tool",
    positioning: "A focused browser-based video utility.",
    targetUsers: ["Creators"],
    coreUserJobs: ["Trim a video quickly"],
    pages: [{ url: "https://example.com/", purpose: "Landing and upload" }],
    workflows: [
      {
        name: "Cut video",
        steps: ["Upload a file", "Choose a range", "Export the result"],
        sourceEvidence: ["Upload button and trimming copy"],
      },
    ],
    features: [
      {
        name: "Upload media",
        description: "Accept a local video file.",
        priority: "must",
      },
    ],
    uxImprovements: ["Make export state clearer."],
    implementationExpectations: ["Use an original visual design."],
    acceptanceCriteria: ["A user can upload and preview a video."],
    risksOrUnknowns: ["Post-upload states were not captured."],
  };
}
