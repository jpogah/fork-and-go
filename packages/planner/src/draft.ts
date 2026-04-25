// Draft phase: one LLM call per proposal. The model receives the proposal
// (id, slug, title, phase, depends_on, summary, scope_bullets) plus the
// draft system prompt and must emit the full markdown body of the plan file
// *without frontmatter* — the planner prepends frontmatter on emit. We parse
// the response as plain text; minimal validation beyond "non-empty + contains
// the required section headings." A malformed draft is a repair candidate.

import {
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "@fork-and-go/model-client";

import type { PlanProposal } from "./schemas.ts";

export interface DraftDeps {
  modelClient: ModelClient;
  systemPrompt: string;
  defaultModel: string;
  repairModel: string;
  maxRepairAttempts?: number;
}

export type DraftResult =
  | {
      ok: true;
      body: string;
      attempts: DraftAttempt[];
      totalUsage: ModelUsage;
    }
  | {
      ok: false;
      reason: string;
      attempts: DraftAttempt[];
      totalUsage: ModelUsage;
    };

export interface DraftAttempt {
  model: string;
  usage: ModelUsage;
  ok: boolean;
  error?: string;
}

// The sections the structural validator requires in every draft body. Kept in
// sync with `scripts/validate_repo_docs.py::PLAN_REQUIRED_HEADINGS`.
export const REQUIRED_SECTIONS: ReadonlyArray<string> = [
  "## Goal",
  "## Why Now",
  "## Scope",
  "## Out Of Scope",
  "## Milestones",
  "## Validation",
  "## Open Questions",
  "## Decision Log",
];

export async function draftPlanBody(
  proposal: PlanProposal,
  deps: DraftDeps,
): Promise<DraftResult> {
  const attempts: DraftAttempt[] = [];
  const maxRepair = deps.maxRepairAttempts ?? 1;
  const totalUsage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
  };

  const baseRequest = buildDraftRequest(
    proposal,
    deps.systemPrompt,
    deps.defaultModel,
  );

  let response: ModelResponse = await deps.modelClient.complete(baseRequest);
  let parsed = parseDraftOutput(response.text);
  attempts.push({
    model: response.model,
    usage: response.usage,
    ok: parsed.ok,
    ...(parsed.ok ? {} : { error: parsed.error }),
  });
  accumulateUsage(totalUsage, response.usage);

  if (parsed.ok) {
    return { ok: true, body: parsed.body, attempts, totalUsage };
  }

  for (let attempt = 0; attempt < maxRepair; attempt += 1) {
    const repairRequest = buildRepairRequest(
      baseRequest,
      response.text,
      parsed.error,
      deps.repairModel,
    );
    response = await deps.modelClient.complete(repairRequest);
    parsed = parseDraftOutput(response.text);
    attempts.push({
      model: response.model,
      usage: response.usage,
      ok: parsed.ok,
      ...(parsed.ok ? {} : { error: parsed.error }),
    });
    accumulateUsage(totalUsage, response.usage);
    if (parsed.ok) {
      return { ok: true, body: parsed.body, attempts, totalUsage };
    }
  }

  return {
    ok: false,
    reason: `draft phase failed after ${attempts.length} attempt(s): ${parsed.error}`,
    attempts,
    totalUsage,
  };
}

type ParseResult = { ok: true; body: string } | { ok: false; error: string };

function parseDraftOutput(text: string): ParseResult {
  // Production responses come through OpenAI Chat Completions with
  // `response_format: { type: "json_object" }` forced on every request
  // (see packages/model-client/src/model-client.ts), so the live LLM usually
  // returns a JSON object. The draft system prompt pins the shape to
  // `{ "body": "<markdown>" }` — anything else is a repair candidate. We
  // still accept plain markdown as a fallback so test fixtures and future
  // non-forced-JSON providers continue to work.
  const extracted = extractBody(text);
  if (!extracted.ok) return extracted;
  const body = extracted.body.trim();
  if (!body) {
    return { ok: false, error: "empty draft body" };
  }
  if (body.startsWith("---")) {
    return {
      ok: false,
      error:
        "draft body must not include YAML frontmatter — the planner prepends it",
    };
  }
  const missing = REQUIRED_SECTIONS.filter(
    (heading) => !bodyHasHeading(body, heading),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `draft is missing required section heading(s): ${missing.join(", ")}`,
    };
  }
  return { ok: true, body };
}

function extractBody(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty draft body" };
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `draft JSON was not valid JSON: ${detail}. Reply with {"body": "<markdown>"}`,
      };
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error: `draft JSON must be an object shaped {"body": "<markdown>"}`,
      };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.body !== "string") {
      return {
        ok: false,
        error: `draft JSON is missing a string "body" field; received keys: ${Object.keys(obj).join(", ") || "(none)"}`,
      };
    }
    return { ok: true, body: obj.body };
  }
  return { ok: true, body: trimmed };
}

function bodyHasHeading(body: string, heading: string): boolean {
  // Match heading on its own line (tolerate trailing whitespace).
  const re = new RegExp(
    `^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m",
  );
  return re.test(body);
}

function buildDraftRequest(
  proposal: PlanProposal,
  systemPrompt: string,
  model: string,
): ModelRequest {
  const payload = {
    id: proposal.id,
    slug: proposal.slug,
    title: proposal.title,
    phase: proposal.phase,
    depends_on: [...proposal.depends_on],
    estimated_passes: proposal.estimated_passes,
    summary: proposal.summary,
    scope_bullets: [...proposal.scope_bullets],
  };
  const userMessage = {
    role: "user" as const,
    content:
      `## Plan proposal\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n` +
      `Respond with a single JSON object shaped exactly \`{"body": "<plan markdown>"}\`. ` +
      `The markdown in \`body\` starts with a top-level ` +
      `\`# ${proposal.id} ${proposal.title}\` heading and includes every required section heading ` +
      `(Goal, Why Now, Scope, Out Of Scope, Milestones, Validation, Open Questions, Decision Log).`,
  };
  return {
    system: systemPrompt,
    messages: [userMessage],
    model,
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
          `## Repair\nYour previous response could not be accepted. ${lastError}\n\n` +
          `Re-emit the full response as a single JSON object \`{"body": "<plan markdown>"}\`. ` +
          `The markdown in \`body\` must include every required section heading and must NOT include YAML frontmatter.`,
      },
    ],
  };
}

function accumulateUsage(total: ModelUsage, delta: ModelUsage): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.costCents = Math.round((total.costCents + delta.costCents) * 100) / 100;
}
