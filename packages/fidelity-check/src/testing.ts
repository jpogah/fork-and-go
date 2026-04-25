// Test-only helpers. Mirrors @fork-and-go/planner/testing so fidelity-check
// tests can reuse the scripted model-client pattern without a cross-package
// dev dependency.

import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "@fork-and-go/builder";

export function scriptedModelClient(
  responses: ReadonlyArray<string>,
): ModelClient & { calls: ModelRequest[] } {
  if (responses.length === 0) {
    throw new Error("scriptedModelClient requires at least one response");
  }
  const calls: ModelRequest[] = [];
  let index = 0;
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const pick = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      const usage: ModelUsage = {
        inputTokens: 100,
        outputTokens: 50,
        costCents: 0.01,
      };
      const response: ModelResponse = {
        text: pick,
        model: request.model ?? "test-model",
        usage,
      };
      return response;
    },
  };
}
