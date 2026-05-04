// @harness/agent-runner — single abstraction over the Claude Agent SDK
// and the Codex SDK. Every harness role (implementer, reviewer, planner,
// fidelity-checker, release-gate) goes through this. Three modes:
//
//   exec     — full tools, file edits, command execution
//   review   — read-only repo access
//   complete — single-turn structured output, no tools by default

export { createAgentRunner } from "./factory.ts";
export { createClaudeRunner } from "./claude-runner.ts";
export { createCodexRunner } from "./codex-runner.ts";

export type {
  AgentCompleteOpts,
  AgentEvent,
  AgentEventKind,
  AgentExecOpts,
  AgentInvocationBase,
  AgentProvider,
  AgentResult,
  AgentReviewOpts,
  AgentRunner,
  AgentRunnerConfig,
  TokenUsage,
} from "./types.ts";

export {
  wrapAgentAsCompletionClient,
  type CompletionClient,
  type CompletionMessage,
  type CompletionRequest,
  type CompletionResponse,
  type CompletionUsage,
  type WrapAgentOptions,
} from "./completion.ts";
