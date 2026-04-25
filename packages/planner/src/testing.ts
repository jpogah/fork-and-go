// Test-only helpers. Kept in a separate entry point so production code
// cannot accidentally depend on them.

import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "@fork-and-go/model-client";

// Build a scripted model client that replays a sequence of canned responses.
// Each call consumes one entry from the queue; calls past the end return the
// final entry (useful for "repair keeps returning the same thing" tests).
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
