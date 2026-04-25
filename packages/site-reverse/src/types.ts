import type { Buffer } from "node:buffer";

import type { PlannerRunOutcome } from "@fork-and-go/planner";

export const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
} as const;

export type ViewportName = keyof typeof VIEWPORT_PRESETS;

export interface SiteCaptureOptions {
  url: string;
  maxPages?: number;
  viewports?: ReadonlyArray<ViewportName>;
  timeoutMs?: number;
  clock?: () => Date;
}

export interface ScreenshotArtifact {
  filename: string;
  viewport: ViewportName;
  url: string;
  content: Buffer;
}

export interface CapturedHeading {
  level: 1 | 2 | 3;
  text: string;
}

export interface CapturedLink {
  text: string;
  href: string;
}

export interface CapturedControl {
  kind: "button" | "input" | "select" | "textarea" | "link-button";
  label: string;
  type?: string;
  placeholder?: string;
}

export interface CapturedForm {
  label: string;
  fields: ReadonlyArray<CapturedControl>;
}

export interface CapturedPage {
  requestedUrl: string;
  finalUrl: string;
  viewport: ViewportName;
  title: string;
  status: number | null;
  textSample: string;
  headings: ReadonlyArray<CapturedHeading>;
  links: ReadonlyArray<CapturedLink>;
  controls: ReadonlyArray<CapturedControl>;
  forms: ReadonlyArray<CapturedForm>;
  landmarks: ReadonlyArray<string>;
  accessibilitySnapshot: unknown;
  screenshot: ScreenshotArtifact;
}

export interface SiteCapture {
  sourceUrl: string;
  normalizedSourceUrl: string;
  origin: string;
  capturedAt: string;
  maxPages: number;
  viewports: ReadonlyArray<ViewportName>;
  pages: ReadonlyArray<CapturedPage>;
}

export interface SiteReverseWritePaths {
  bundleDir: string;
  specPath: string;
  contextDropPath: string;
  captureJsonPath: string;
  analysisJsonPath: string;
  sourceAnalysisPath: string;
  screenshotsDir: string;
  screenshotPaths: ReadonlyArray<string>;
}

export interface SiteReverseResult {
  capture: SiteCapture;
  analysis: SiteAnalysis;
  productSpec: string;
  paths: SiteReverseWritePaths;
  plannerOutcome?: PlannerRunOutcome;
}

export interface SiteAnalysisPage {
  url: string;
  purpose: string;
}

export interface SiteAnalysisWorkflow {
  name: string;
  steps: ReadonlyArray<string>;
  sourceEvidence: ReadonlyArray<string>;
}

export interface SiteAnalysisFeature {
  name: string;
  description: string;
  priority: "must" | "should" | "could";
}

export interface SiteAnalysis {
  appName: string;
  positioning: string;
  targetUsers: ReadonlyArray<string>;
  coreUserJobs: ReadonlyArray<string>;
  pages: ReadonlyArray<SiteAnalysisPage>;
  workflows: ReadonlyArray<SiteAnalysisWorkflow>;
  features: ReadonlyArray<SiteAnalysisFeature>;
  uxImprovements: ReadonlyArray<string>;
  implementationExpectations: ReadonlyArray<string>;
  acceptanceCriteria: ReadonlyArray<string>;
  risksOrUnknowns: ReadonlyArray<string>;
}
