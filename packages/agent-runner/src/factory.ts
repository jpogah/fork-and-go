// Factory: pick the right backend based on config.

import { createClaudeRunner } from "./claude-runner.ts";
import { createCodexRunner } from "./codex-runner.ts";
import type { AgentRunner, AgentRunnerConfig } from "./types.ts";

export function createAgentRunner(config: AgentRunnerConfig): AgentRunner {
  if (config.provider === "claude") return createClaudeRunner(config);
  if (config.provider === "codex") return createCodexRunner(config);
  // The Zod schema rejects anything else upstream; this branch keeps the
  // type checker happy without inventing a third provider.
  const provider: never = config.provider;
  throw new Error(`unknown agent provider: ${provider as string}`);
}
