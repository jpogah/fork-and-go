// Env-driven ModelClient selector (plan 0055). Defaults to the subprocess
// Codex CLI path — forkers install `codex`, log in, done. Opting into the
// OpenAI-API path requires `BUILDER_LLM_CLIENT=openai` AND `OPENAI_API_KEY`.
//
// The factory is the *only* place the two transports are crossed. Consumers
// (planner, fidelity-check, the Builder interviewer) keep talking to the
// opaque `ModelClient` interface.

import {
  createCliModelClient,
  type CliModelClientOptions,
} from "./cli-model-client.ts";
import {
  createOpenAIClient,
  type ModelClient,
  type OpenAIClientOptions,
} from "./model-client.ts";

export type CreateModelClientOptions = {
  // Test seam / runtime override. Defaults to `process.env`.
  env?: Readonly<Record<string, string | undefined>>;
  cli?: CliModelClientOptions;
  openai?: Partial<Omit<OpenAIClientOptions, "apiKey">> & { apiKey?: string };
};

export const BUILDER_LLM_CLIENT_ENV = "BUILDER_LLM_CLIENT";
export const BUILDER_CLI_TIMEOUT_MS_ENV = "BUILDER_CLI_TIMEOUT_MS";

export function createModelClient(
  options: CreateModelClientOptions = {},
): ModelClient {
  const env =
    options.env ?? (process.env as Record<string, string | undefined>);
  const kind = resolveKind(env[BUILDER_LLM_CLIENT_ENV]);

  if (kind === "openai") {
    const apiKey = options.openai?.apiKey ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        `${BUILDER_LLM_CLIENT_ENV}=openai set but OPENAI_API_KEY is not`,
      );
    }
    return createOpenAIClient({
      apiKey,
      ...(options.openai?.baseURL !== undefined
        ? { baseURL: options.openai.baseURL }
        : {}),
      ...(options.openai?.defaultModel !== undefined
        ? { defaultModel: options.openai.defaultModel }
        : {}),
      ...(options.openai?.client !== undefined
        ? { client: options.openai.client }
        : {}),
    });
  }

  const cliOpts: CliModelClientOptions = { ...(options.cli ?? {}) };
  if (cliOpts.timeoutMs === undefined) {
    const fromEnv = parseTimeout(env[BUILDER_CLI_TIMEOUT_MS_ENV]);
    if (fromEnv !== null) cliOpts.timeoutMs = fromEnv;
  }
  return createCliModelClient(cliOpts);
}

function resolveKind(raw: string | undefined): "cli" | "openai" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "cli") return "cli";
  if (value === "openai") return "openai";
  throw new Error(
    `${BUILDER_LLM_CLIENT_ENV} must be "cli" or "openai"; got "${raw}"`,
  );
}

function parseTimeout(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${BUILDER_CLI_TIMEOUT_MS_ENV} must be a positive integer (ms); got "${raw}"`,
    );
  }
  return parsed;
}
