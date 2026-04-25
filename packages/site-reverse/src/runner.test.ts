import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "@fork-and-go/model-client";
import { afterEach, describe, expect, it } from "vitest";

import { runSiteReverse } from "./runner.ts";
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runSiteReverse", () => {
  it("writes the generated bundle and spec without invoking planner when skipped", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "site-reverse-"));
    tempDirs.push(repoRoot);
    const result = await runSiteReverse(
      {
        sourceUrl: "https://example.com/",
        slug: "video-tool",
        repoRoot,
        plannerMode: "skip",
      },
      {
        modelClient: scriptedModelClient([VALID_ANALYSIS]),
        captureSite: async () => sampleCapture(),
      },
    );

    expect(existsSync(result.paths.specPath)).toBe(true);
    expect(existsSync(result.paths.captureJsonPath)).toBe(true);
    expect(existsSync(result.paths.contextDropPath)).toBe(true);
    expect(existsSync(result.paths.screenshotPaths[0] ?? "")).toBe(true);
    expect(readFileSync(result.paths.specPath, "utf8")).toContain(
      "Better Video Cutter Rebuild",
    );
    expect(result.plannerOutcome).toBeUndefined();
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
