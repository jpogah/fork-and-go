// Provider-agnostic model client for harness-level LLM calls. Planner and
// fidelity-check code depend only on the `ModelClient` interface, so the
// runtime transport can be Codex CLI or OpenAI without changing callers.
//
// We use OpenAI Chat Completions with `response_format: { type: "json_object" }`
// rather than json_schema strict mode: strict mode rejects open-ended objects
// and can make reusable harness prompts brittle. Planner and fidelity-check
// each validate the returned JSON with package-local Zod schemas.
//
// The `system` field on the request maps to an OpenAI `system` role message;
// history messages carry their existing `user` / `assistant` roles.
//
// Callers can override `model` per request. Planner and fidelity-check use
// `gpt-5.4-mini` for default attempts and `gpt-5.4` for repair attempts.
//
// Errors from the SDK surface as `ModelClientError` with the raw status text
// preserved for diagnostics (never the API key).

import OpenAI from "openai";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  // Approximate cost in US-cents, attributed to the caller's workspace.
  costCents: number;
};

export type ModelRequest = {
  system: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  // Defaults to `gpt-5.4-mini`. Callers can set `gpt-5.4` for repair attempts.
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ModelResponse = {
  text: string;
  usage: ModelUsage;
  model: string;
};

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

const DEFAULT_MODEL = "gpt-5.4-mini";
const REPAIR_MODEL = "gpt-5.4";
// GPT-5 reasoning models spend tokens from this same budget on internal
// reasoning before emitting the visible JSON. 1024 was the Claude-era value
// and truncates multi-op patches after a few hundred reasoning tokens; 4096
// gives comfortable headroom for both reasoning and a full turn response.
const DEFAULT_MAX_TOKENS = 4096;
// OpenAI GPT-5.4 public pricing (April 2026), in US-cents per million tokens.
// The mini/full split mirrors the planner/fidelity default/repair tiering.
const MINI_INPUT_CENTS_PER_MTOK = 25;
const MINI_OUTPUT_CENTS_PER_MTOK = 200;
const FULL_INPUT_CENTS_PER_MTOK = 250;
const FULL_OUTPUT_CENTS_PER_MTOK = 2000;

export const MODEL_CLIENT_DEFAULT_MODEL = DEFAULT_MODEL;
export const MODEL_CLIENT_REPAIR_MODEL = REPAIR_MODEL;

export function estimateCostCents(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const isMini = model.includes("mini");
  const inputRate = isMini
    ? MINI_INPUT_CENTS_PER_MTOK
    : FULL_INPUT_CENTS_PER_MTOK;
  const outputRate = isMini
    ? MINI_OUTPUT_CENTS_PER_MTOK
    : FULL_OUTPUT_CENTS_PER_MTOK;
  const inputCost = (usage.inputTokens / 1_000_000) * inputRate;
  const outputCost = (usage.outputTokens / 1_000_000) * outputRate;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

export type OpenAIClientOptions = {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  // Overrideable for tests that don't want to depend on the SDK shape.
  client?: OpenAILike;
};

// Minimal view of the SDK surface we use. Kept narrow so a test double can
// satisfy it without reconstructing the full OpenAI client.
export type OpenAILike = {
  chat: {
    completions: {
      create: (
        params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
};

export function createOpenAIClient(options: OpenAIClientOptions): ModelClient {
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  const client: OpenAILike =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    });

  return {
    async complete(request) {
      const model = request.model ?? defaultModel;
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
        {
          model,
          max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [
            { role: "system", content: request.system },
            ...request.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          ],
          response_format: { type: "json_object" },
        };
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create(params);
      } catch (err) {
        const status =
          err instanceof OpenAI.APIError && typeof err.status === "number"
            ? err.status
            : "unknown";
        const body =
          err instanceof OpenAI.APIError
            ? (err.message ?? "")
            : err instanceof Error
              ? err.message
              : String(err);
        throw new ModelClientError(
          `model request failed with status ${status}`,
          body,
        );
      }

      const text = completion.choices[0]?.message?.content ?? "";
      const rawUsage = completion.usage;
      const inputTokens = rawUsage?.prompt_tokens ?? 0;
      const outputTokens = rawUsage?.completion_tokens ?? 0;
      const usage: ModelUsage = {
        inputTokens,
        outputTokens,
        costCents: estimateCostCents(completion.model, {
          inputTokens,
          outputTokens,
        }),
      };

      return {
        text,
        model: completion.model,
        usage,
      };
    },
  };
}

export class ModelClientError extends Error {
  readonly body: string;
  constructor(message: string, body = "") {
    super(message);
    this.name = "ModelClientError";
    this.body = body;
  }
}
