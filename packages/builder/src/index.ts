// @fork-and-go/builder — minimal LLM-client surface for Fork-and-Go
// harness consumers (planner and fidelity-check).
//
// This is the stripped-down generic harness version: only the
// model-client pieces are included. Product-specific
// modules (interviewer, spec-editor, guardrails, patch-application,
// audit sinks, builder prompts) are removed because they depend on
// product-local agent-spec artifacts that are not suitable for a generic
// harness consumer.

export {
  BUILDER_DEFAULT_MODEL,
  BUILDER_REPAIR_MODEL,
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
  BUILDER_CLI_TIMEOUT_MS_ENV,
  BUILDER_LLM_CLIENT_ENV,
  createModelClient,
  type CreateModelClientOptions,
} from "./model-client-factory.ts";
