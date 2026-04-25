import { describe, expect, it } from "vitest";

import {
  defaultSlugFromUrl,
  normalizeDiscoveredUrl,
  normalizeHttpUrl,
  screenshotFilename,
  toSafeSlug,
} from "./url.ts";

describe("url helpers", () => {
  it("normalizes http URLs and strips fragments", () => {
    expect(normalizeHttpUrl("https://example.com/path#section")).toBe(
      "https://example.com/path",
    );
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeHttpUrl("file:///tmp/app.html")).toThrow(
      /Only http and https URLs/,
    );
  });

  it("normalizes discovered relative links against a base URL", () => {
    expect(normalizeDiscoveredUrl("/tools#top", "https://example.com/app/")).toBe(
      "https://example.com/tools",
    );
  });

  it("derives stable slugs from URLs", () => {
    expect(defaultSlugFromUrl("https://www.online-video-cutter.com/")).toBe(
      "online-video-cutter-com",
    );
    expect(toSafeSlug("Better Video Cutter!")).toBe("better-video-cutter");
  });

  it("creates screenshot filenames from URL and viewport", () => {
    expect(screenshotFilename("https://example.com/tools/cut?a=1", "mobile")).toBe(
      "example-com-tools-cut-a-1-mobile.png",
    );
  });
});
