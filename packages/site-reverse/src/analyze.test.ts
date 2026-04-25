import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "@fork-and-go/model-client";
import { describe, expect, it } from "vitest";

import { analyzeCapturedSite } from "./analyze.ts";
import type { SiteCapture } from "./types.ts";

const VALID_ANALYSIS = JSON.stringify({
  appName: "Better Video Cutter",
  positioning: "A browser-based video cutter with clearer upload and export flow.",
  targetUsers: ["Creators"],
  coreUserJobs: ["Trim a video without installing software"],
  pages: [{ url: "https://example.com/", purpose: "Upload entry point" }],
  workflows: [
    {
      name: "Trim video",
      steps: ["Upload media", "Select time range", "Export trimmed file"],
      sourceEvidence: ["Heading: Online Video Cutter"],
    },
  ],
  features: [
    {
      name: "Media upload",
      description: "Accept a local media file and show progress.",
      priority: "must",
    },
  ],
  uxImprovements: ["Show export status inline."],
  implementationExpectations: ["Use original branding and assets."],
  acceptanceCriteria: ["A user can upload a video from the landing page."],
  risksOrUnknowns: ["Post-upload editor states were not captured."],
});

describe("analyzeCapturedSite", () => {
  it("parses a valid model response", async () => {
    const client = scriptedModelClient([VALID_ANALYSIS]);
    const result = await analyzeCapturedSite(
      { capture: sampleCapture() },
      { modelClient: client, systemPrompt: "SYSTEM", defaultModel: "mini" },
    );

    expect(result.analysis.appName).toBe("Better Video Cutter");
    expect(result.attempts).toHaveLength(1);
    expect(client.calls[0]?.messages[0]?.content).toContain("rebuildPolicy");
  });

  it("repairs malformed model output once", async () => {
    const client = scriptedModelClient(["not json", VALID_ANALYSIS]);
    const result = await analyzeCapturedSite(
      { capture: sampleCapture() },
      {
        modelClient: client,
        systemPrompt: "SYSTEM",
        defaultModel: "mini",
        repairModel: "full",
      },
    );

    expect(result.analysis.appName).toBe("Better Video Cutter");
    expect(result.attempts).toHaveLength(2);
    expect(client.calls[1]?.model).toBe("full");
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
    pages: [
      {
        requestedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        viewport: "desktop",
        title: "Online Video Cutter",
        status: 200,
        textSample: "Online Video Cutter Upload video",
        headings: [{ level: 1, text: "Online Video Cutter" }],
        links: [],
        controls: [{ kind: "button", label: "Upload video" }],
        forms: [],
        landmarks: ["main: Online Video Cutter"],
        accessibilitySnapshot: null,
        screenshot: {
          filename: "example-com-desktop.png",
          viewport: "desktop",
          url: "https://example.com/",
          content: Buffer.from("png"),
        },
      },
    ],
  };
}

function scriptedModelClient(
  responses: ReadonlyArray<string>,
): ModelClient & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  let index = 0;
  return {
    calls,
    async complete(request): Promise<ModelResponse> {
      calls.push(request);
      const text = responses[Math.min(index, responses.length - 1)] ?? "{}";
      index += 1;
      const usage: ModelUsage = {
        inputTokens: 10,
        outputTokens: 5,
        costCents: 0.01,
      };
      return { text, usage, model: request.model ?? "test-model" };
    },
  };
}
