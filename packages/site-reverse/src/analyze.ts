import {
  MODEL_CLIENT_DEFAULT_MODEL,
  MODEL_CLIENT_REPAIR_MODEL,
  type ModelClient,
  type ModelRequest,
  type ModelUsage,
} from "@fork-and-go/model-client";
import { z } from "zod";

import { loadSiteReversePrompts } from "./prompts.ts";
import type { CapturedPage, SiteAnalysis, SiteCapture } from "./types.ts";

const featurePrioritySchema = z.enum(["must", "should", "could"]);

export const siteAnalysisSchema = z
  .object({
    appName: z.string().min(1),
    positioning: z.string().min(1),
    targetUsers: z.array(z.string().min(1)).min(1),
    coreUserJobs: z.array(z.string().min(1)).min(1),
    pages: z
      .array(
        z
          .object({
            url: z.string().min(1),
            purpose: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            steps: z.array(z.string().min(1)).min(1),
            sourceEvidence: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    features: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            priority: featurePrioritySchema,
          })
          .strict(),
      )
      .min(1),
    uxImprovements: z.array(z.string().min(1)).min(1),
    implementationExpectations: z.array(z.string().min(1)).min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    risksOrUnknowns: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface AnalyzeCapturedSiteInput {
  capture: SiteCapture;
  operatorNotes?: string;
}

export interface AnalyzeCapturedSiteDeps {
  modelClient: ModelClient;
  systemPrompt?: string;
  defaultModel?: string;
  repairModel?: string;
  maxRepairAttempts?: number;
}

export type AnalyzeCapturedSiteResult = {
  analysis: SiteAnalysis;
  attempts: ReadonlyArray<AnalysisAttempt>;
  totalUsage: ModelUsage;
};

export interface AnalysisAttempt {
  model: string;
  usage: ModelUsage;
  ok: boolean;
  error?: string;
}

type ParseResult =
  | { ok: true; analysis: SiteAnalysis }
  | { ok: false; error: string };

export async function analyzeCapturedSite(
  input: AnalyzeCapturedSiteInput,
  deps: AnalyzeCapturedSiteDeps,
): Promise<AnalyzeCapturedSiteResult> {
  const systemPrompt = deps.systemPrompt ?? loadSiteReversePrompts().analyze;
  const defaultModel = deps.defaultModel ?? MODEL_CLIENT_DEFAULT_MODEL;
  const repairModel = deps.repairModel ?? MODEL_CLIENT_REPAIR_MODEL;
  const maxRepairAttempts = deps.maxRepairAttempts ?? 1;
  const attempts: AnalysisAttempt[] = [];
  const totalUsage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
  };

  const baseRequest = buildAnalysisRequest(input, systemPrompt, defaultModel);
  let response = await deps.modelClient.complete(baseRequest);
  let parsed = parseAnalysisOutput(response.text);
  attempts.push({
    model: response.model,
    usage: response.usage,
    ok: parsed.ok,
    ...(parsed.ok ? {} : { error: parsed.error }),
  });
  addUsage(totalUsage, response.usage);
  if (parsed.ok) {
    return { analysis: parsed.analysis, attempts, totalUsage };
  }

  for (let index = 0; index < maxRepairAttempts; index += 1) {
    response = await deps.modelClient.complete(
      buildRepairRequest(baseRequest, response.text, parsed.error, repairModel),
    );
    parsed = parseAnalysisOutput(response.text);
    attempts.push({
      model: response.model,
      usage: response.usage,
      ok: parsed.ok,
      ...(parsed.ok ? {} : { error: parsed.error }),
    });
    addUsage(totalUsage, response.usage);
    if (parsed.ok) {
      return { analysis: parsed.analysis, attempts, totalUsage };
    }
  }

  throw new Error(
    `site analysis failed after ${attempts.length} attempt(s): ${parsed.error}`,
  );
}

function buildAnalysisRequest(
  input: AnalyzeCapturedSiteInput,
  systemPrompt: string,
  model: string,
): ModelRequest {
  const payload = {
    capture: summarizeCapture(input.capture),
    operatorNotes: input.operatorNotes ?? "",
    rebuildPolicy: {
      stance: "improved original implementation",
      forbidden: [
        "copying proprietary source",
        "trademark or brand impersonation",
        "hotlinking source assets",
        "recreating protected media",
      ],
    },
  };
  return {
    system: systemPrompt,
    model,
    maxTokens: 4096,
    messages: [
      {
        role: "user",
        content:
          "Analyze this captured website evidence and return the required JSON object.\n\n" +
          "```json\n" +
          JSON.stringify(payload, null, 2) +
          "\n```",
      },
    ],
  };
}

function buildRepairRequest(
  base: ModelRequest,
  lastResponseText: string,
  lastError: string,
  repairModel: string,
): ModelRequest {
  return {
    ...base,
    model: repairModel,
    messages: [
      ...base.messages,
      { role: "assistant", content: lastResponseText },
      {
        role: "user",
        content:
          `Your previous response did not match the required JSON contract: ${lastError}\n` +
          "Return only a valid JSON object with the exact required shape.",
      },
    ],
  };
}

function parseAnalysisOutput(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `response was not valid JSON: ${detail}` };
  }
  const result = siteAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, analysis: result.data };
}

function summarizeCapture(capture: SiteCapture): object {
  return {
    sourceUrl: capture.sourceUrl,
    normalizedSourceUrl: capture.normalizedSourceUrl,
    origin: capture.origin,
    capturedAt: capture.capturedAt,
    maxPages: capture.maxPages,
    viewports: capture.viewports,
    pages: capture.pages.map(summarizePage),
  };
}

function summarizePage(page: CapturedPage): object {
  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    viewport: page.viewport,
    title: page.title,
    status: page.status,
    screenshot: page.screenshot.filename,
    headings: page.headings,
    links: page.links.slice(0, 60),
    controls: page.controls.slice(0, 80),
    forms: page.forms.slice(0, 20),
    landmarks: page.landmarks.slice(0, 50),
    textSample: page.textSample.slice(0, 6000),
    accessibilitySnapshot: page.accessibilitySnapshot,
  };
}

function addUsage(total: ModelUsage, usage: ModelUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.costCents = Math.round((total.costCents + usage.costCents) * 100) / 100;
}
