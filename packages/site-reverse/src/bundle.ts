import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderSourceAnalysisMarkdown } from "./spec.ts";
import type {
  SiteAnalysis,
  SiteCapture,
  SiteReverseWritePaths,
} from "./types.ts";
import { assertSafeSlug, SiteReverseError } from "./url.ts";

export interface WriteSiteReverseBundleOptions {
  repoRoot: string;
  slug: string;
  capture: SiteCapture;
  analysis: SiteAnalysis;
  productSpec: string;
  force?: boolean;
}

export function writeSiteReverseBundle(
  options: WriteSiteReverseBundleOptions,
): SiteReverseWritePaths {
  assertSafeSlug(options.slug);
  const docsDir = path.join(options.repoRoot, "docs");
  const specDir = path.join(docsDir, "product-specs");
  const contextDir = path.join(docsDir, "context");
  const bundleDir = path.join(contextDir, "site-reverse", options.slug);
  const screenshotsDir = path.join(bundleDir, "screenshots");
  const inboxDir = path.join(contextDir, "inbox");

  const specPath = path.join(specDir, `${options.slug}.md`);
  const captureJsonPath = path.join(bundleDir, "capture.json");
  const analysisJsonPath = path.join(bundleDir, "analysis.json");
  const sourceAnalysisPath = path.join(bundleDir, "source-analysis.md");
  const contextDropPath = path.join(inboxDir, `${options.slug}-site-reverse.md`);

  const screenshotPaths = options.capture.pages.map((page) =>
    path.join(screenshotsDir, page.screenshot.filename),
  );
  const allTargets = [
    specPath,
    captureJsonPath,
    analysisJsonPath,
    sourceAnalysisPath,
    contextDropPath,
    ...screenshotPaths,
  ];
  if (!options.force) {
    const existing = allTargets.find((target) => existsSync(target));
    if (existing) {
      throw new SiteReverseError(
        `Refusing to overwrite existing generated file: ${existing}. Re-run with --force to replace it.`,
      );
    }
  }

  mkdirSync(specDir, { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });

  writeFileSync(specPath, options.productSpec, "utf8");
  writeFileSync(
    captureJsonPath,
    JSON.stringify(serializeCapture(options.capture), null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    analysisJsonPath,
    JSON.stringify(options.analysis, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    sourceAnalysisPath,
    renderSourceAnalysisMarkdown({
      slug: options.slug,
      capture: options.capture,
      analysis: options.analysis,
    }),
    "utf8",
  );
  writeFileSync(
    contextDropPath,
    renderSourceAnalysisMarkdown({
      slug: options.slug,
      capture: options.capture,
      analysis: options.analysis,
    }),
    "utf8",
  );
  for (const page of options.capture.pages) {
    writeFileSync(
      path.join(screenshotsDir, page.screenshot.filename),
      page.screenshot.content,
    );
  }

  return {
    bundleDir,
    specPath,
    contextDropPath,
    captureJsonPath,
    analysisJsonPath,
    sourceAnalysisPath,
    screenshotsDir,
    screenshotPaths,
  };
}

function serializeCapture(capture: SiteCapture): object {
  return {
    ...capture,
    pages: capture.pages.map((page) => ({
      ...page,
      screenshot: {
        filename: page.screenshot.filename,
        viewport: page.screenshot.viewport,
        url: page.screenshot.url,
        bytes: page.screenshot.content.length,
      },
    })),
  };
}
