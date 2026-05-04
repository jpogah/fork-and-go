// Shared types for the AgentRunner abstraction. The harness funnels every
// agent invocation — implementer, reviewer, planner, fidelity-check,
// release-gate — through this interface. Two implementations sit behind
// it: ClaudeRunner (Claude Agent SDK) and CodexRunner (Codex SDK).

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Estimated cost in US-cents. -1 if the SDK didn't report cost; the
  // budget tracker uses 0 in that case (it's CLI-auth, not API-billed).
  costCents: number;
};

export type AgentEventKind =
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "assistant.message"
  | "reasoning"
  | "command.executed"
  | "file.changed"
  | "rate_limit"
  | "error";

export type AgentEvent = {
  kind: AgentEventKind;
  // Best-effort, human-readable line for log writers. Always present.
  text: string;
  // Raw SDK event for advanced consumers. Shape varies by provider.
  raw?: unknown;
};

export type AgentResult = {
  // Final assistant text (the model's last natural-language response).
  message: string;
  tokensUsed: TokenUsage;
  // Set when the SDK reported a rate-limit/usage-limit failure mid-run.
  // The runner caller (run_task loop or daemon) uses this to decide
  // whether to back off.
  rateLimitHit?: { reason: string };
  // True iff the run completed without a hard error (rate limits and
  // tool failures don't flip this; only an unrecoverable transport
  // failure does).
  ok: boolean;
};

// Common to all three modes: prompt + cwd + model + abort.
export type AgentInvocationBase = {
  prompt: string;
  cwd: string;
  model?: string;
  abortSignal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  // Extra system instruction prepended to the prompt. Optional; provider
  // wrappers concatenate it onto their native system-prompt slot.
  systemPrompt?: string;
};

// `exec` — the implementer/fix/prepare-pr roles. Full tool set, file
// edits, command execution. Bypasses prompts.
export type AgentExecOpts = AgentInvocationBase & {
  // Optional explicit allowed tools — when omitted, the provider's full
  // exec-mode default applies (everything in claude_code preset, or
  // workspace-write sandbox for codex).
  allowedTools?: string[];
  // Hard cap on agent turns. Defaults to provider-specific large value;
  // setting it lets the harness bound runaway loops at the wrapper layer.
  maxTurns?: number;
};

// `review` — the read-only review/audit role. Reads the repo, runs
// commands that don't mutate state, but can't edit files.
export type AgentReviewOpts = AgentInvocationBase & {
  allowedTools?: string[];
  maxTurns?: number;
};

// `complete` — single-turn structured output (planner, fidelity-check,
// site-reverse output JSON). No tools by default; caller can opt into
// read-only tools to give the agent context lookups. Always returns
// the model's text in `result.message`.
export type AgentCompleteOpts = AgentInvocationBase & {
  // When set, agent may call these read-only tools to ground its output.
  // Default: no tools.
  allowedTools?: string[];
  // Caller-supplied JSON schema for structured output. The wrapper
  // forwards it to the SDK where supported (`outputSchema` on Codex,
  // structured output on Claude); when not supported, the wrapper
  // appends a "respond with JSON matching this schema" instruction.
  outputSchema?: unknown;
};

export interface AgentRunner {
  exec(opts: AgentExecOpts): Promise<AgentResult>;
  review(opts: AgentReviewOpts): Promise<AgentResult>;
  complete(opts: AgentCompleteOpts): Promise<AgentResult>;
}

export type AgentProvider = "claude" | "codex";

export type AgentRunnerConfig = {
  provider: AgentProvider;
  model?: string;
  // Codex-only knob; ignored by the Claude runner.
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  // Test seam: skip git repo check for codex sandbox runs against
  // fixture dirs that aren't git repos.
  skipGitRepoCheck?: boolean;
};
