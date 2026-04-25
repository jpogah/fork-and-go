// @fork-and-go/model-client — minimal LLM-client surface for Fork-and-Go
// harness consumers such as planner and fidelity-check.

export {
  MODEL_CLIENT_DEFAULT_MODEL,
  MODEL_CLIENT_REPAIR_MODEL,
  ModelClientError,
  createOpenAIClient,
  estimateCostCents,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type OpenAIClientOptions,
  type OpenAILike,
} from "./model-client.ts";

export {
  CliModelClientError,
  DEFAULT_CLI_TIMEOUT_MS,
  createCliModelClient,
  type CliModelClientOptions,
  type SpawnLike,
} from "./cli-model-client.ts";

export {
  MODEL_CLIENT_CLI_TIMEOUT_MS_ENV,
  MODEL_CLIENT_KIND_ENV,
  createModelClient,
  type CreateModelClientOptions,
} from "./model-client-factory.ts";
