// CompletionClient — a small adapter over AgentRunner.complete() for
// callers that want a "system prompt + messages -> JSON text" API
// (planner, fidelity-check, site-reverse). It exists because those
// callers were originally built against an OpenAI-style interface, and
// the cleanest way to migrate them to the agent SDKs without rewriting
// their entire flow is to satisfy the same shape from the agent runner.
//
// CRITICAL: the underlying transport is still 100% agent-SDK
// (Claude Agent SDK or Codex SDK) — there are no direct API calls
// anywhere. This is just a method-shape shim so callers can stay
// stateless ("give me one JSON response") instead of having to manage
// AgentEvent streams.

import type { AgentResult, AgentRunner } from "./types.ts";

export type CompletionMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  system: string;
  messages: ReadonlyArray<CompletionMessage>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type CompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
};

export type CompletionResponse = {
  text: string;
  usage: CompletionUsage;
  model: string;
};

export interface CompletionClient {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export type WrapAgentOptions = {
  // Agent provider name surfaced in CompletionResponse.model when the
  // SDK doesn't echo a model string. Defaults to "agent".
  providerLabel?: string;
  // Caller can override the cwd that the agent runs in. Defaults to
  // process.cwd() — the agent has no tools in `complete` mode anyway,
  // so cwd only matters if the caller opts into read-only tools.
  cwd?: string;
};

export function wrapAgentAsCompletionClient(
  runner: AgentRunner,
  options: WrapAgentOptions = {},
): CompletionClient {
  const cwd = options.cwd ?? process.cwd();
  const providerLabel = options.providerLabel ?? "agent";
  return {
    async complete(request) {
      const prompt = flattenMessages(request);
      const result = await runner.complete({
        prompt,
        cwd,
        systemPrompt: request.system,
        ...(request.model ? { model: request.model } : {}),
      });
      return toCompletionResponse(result, request.model ?? providerLabel);
    },
  };
}

function flattenMessages(request: CompletionRequest): string {
  if (request.messages.length === 1 && request.messages[0]!.role === "user") {
    return request.messages[0]!.content;
  }
  // Multi-turn input (e.g., planner's repair pattern). Render the
  // transcript inline so the agent sees the prior assistant attempt
  // and the user's correction.
  return request.messages
    .map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}`)
    .join("\n\n");
}

function toCompletionResponse(
  result: AgentResult,
  model: string,
): CompletionResponse {
  return {
    text: result.message,
    usage: {
      inputTokens: result.tokensUsed.inputTokens,
      outputTokens: result.tokensUsed.outputTokens,
      costCents: result.tokensUsed.costCents,
    },
    model,
  };
}
