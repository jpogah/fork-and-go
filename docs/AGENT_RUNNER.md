# `@harness/agent-runner` reference

Single abstraction over the official Claude Agent SDK and Codex SDK. **Every** harness role — implementer, reviewer, planner, fidelity-checker, release-gate — goes through this. There are no direct API calls anywhere in the harness; there are no `claude` / `codex` CLI subprocesses.

## Why this exists

Without the abstraction, every consumer would import a specific SDK and the harness would be permanently coupled to one provider. With it, swapping Claude for Codex is a config flag (`agent.provider`). Adding a third provider is a single new file.

The abstraction also gives every consumer the same three behaviors regardless of provider — full-tool execution, read-only review, no-tool completion — so callers can pick the right capability slice for their role.

## Three modes

```ts
interface AgentRunner {
  exec(opts: AgentExecOpts): Promise<AgentResult>;
  review(opts: AgentReviewOpts): Promise<AgentResult>;
  complete(opts: AgentCompleteOpts): Promise<AgentResult>;
}
```

### `exec` — full tools, file edits, command execution

For implementer / fix / prepare-pr roles. The agent has the provider's full tool set: file edits, bash, web search where supported, MCP servers if configured.

- **Claude:** `permissionMode: "bypassPermissions"`. Tools default to the `claude_code` preset.
- **Codex:** `sandboxMode: "workspace-write"`. The thread is started in the target repo with full filesystem write access scoped to the working directory.

```ts
const result = await runner.exec({
  prompt: implementationPrompt,
  cwd: targetRepoRoot,
  systemPrompt: "...",          // optional, prepended
  model: "claude-sonnet-4-6",   // optional, overrides config
  maxTurns: 50,                 // optional cap
  abortSignal,                  // optional cancellation
  onEvent: (e) => log(e.text),  // optional streaming hook
});
```

### `review` — read-only

For review / review-ui / merge-check / fidelity roles. The agent can read the repo, grep, run shell commands that don't mutate state, but cannot edit files.

- **Claude:** `permissionMode: "default"`, `allowedTools: ["Read", "Grep", "Glob", "Bash"]`, plus an explicit `disallowedTools: ["Edit", "Write", "NotebookEdit"]` belt-and-suspenders.
- **Codex:** `sandboxMode: "read-only"`.

`review-ui` specifically opts in to MCP servers (Playwright) by passing custom `allowedTools` — see `runner/phases.ts:runReviewUi`.

### `complete` — single-turn, no tools (by default)

For structured-output roles: planner JSON, fidelity drift report, site-reverse analysis. The agent must respond with a single JSON object; no tool calls.

- **Claude:** `permissionMode: "default"`, `tools: []`.
- **Codex:** `sandboxMode: "read-only"`, plus a system instruction "do not call any tools, return JSON only" since the SDK doesn't have an explicit no-tools flag.

`complete` accepts an optional `outputSchema` that gets forwarded to the SDK where supported (`turnOptions.outputSchema` on Codex) and inlined as a system-prompt instruction otherwise.

```ts
const result = await runner.complete({
  prompt: plannerPrompt,
  cwd: targetRepoRoot,
  systemPrompt: "you are a planner",
  outputSchema: { /* JSON schema */ },
});
const plan = JSON.parse(result.message);
```

Callers that want their `complete` agent to read the repo for grounding can pass `allowedTools: ["Read", "Grep", "Glob"]` — the result is "single-turn JSON output, but the agent could pull context first."

## `AgentResult`

```ts
type AgentResult = {
  message: string;          // final assistant text (or JSON string)
  tokensUsed: TokenUsage;   // input/output/cache tokens + costCents (when SDK reports)
  rateLimitHit?: { reason: string };  // set when SDK reported rate-limit
  ok: boolean;              // false on hard transport failure
};
```

The `rateLimitHit` field is the harness's signal to back off and retry. The orchestrator daemon checks this and applies `rateLimitBackoffMs` before re-invocation.

`tokensUsed.costCents` is `0` when the SDK doesn't report cost (CLI-auth runs); the per-plan `tokens-used.json` records still carry input/output token counts so operators can audit afterward.

## `CompletionClient` adapter

Most harness roles want a "give me one JSON response" call shape, not the streaming-event API. `wrapAgentAsCompletionClient` adapts an `AgentRunner` to that shape:

```ts
import { createAgentRunner, wrapAgentAsCompletionClient } from "@harness/agent-runner";

const runner = createAgentRunner({ provider: "claude" });
const completionClient = wrapAgentAsCompletionClient(runner, { cwd: repoRoot });

const response = await completionClient.complete({
  system: "you are a planner",
  messages: [{ role: "user", content: "decompose this spec: ..." }],
});
console.log(response.text);  // JSON string
```

The adapter flattens multi-turn `messages` arrays into a single prompt with `### USER` / `### ASSISTANT` separators — that's how the planner's repair-pattern (re-feed bad JSON for correction) works on top of `complete`.

## Provider selection

```ts
import { createAgentRunner } from "@harness/agent-runner";

createAgentRunner({ provider: "claude" });
createAgentRunner({ provider: "codex", reasoningEffort: "medium" });
```

The factory rejects unknown providers at runtime. Adding a third (e.g., a self-hosted backend) means adding a new file `src/<name>-runner.ts` that satisfies `AgentRunner`, registering it in `factory.ts`, and extending the `AgentProvider` union.

## Streaming events (advanced)

Both runners translate native SDK events into a normalized `AgentEvent` stream:

```ts
type AgentEventKind =
  | "thread.started"   | "turn.started"
  | "turn.completed"   | "turn.failed"
  | "tool.started"     | "tool.completed"   | "tool.failed"
  | "assistant.message"
  | "reasoning"
  | "command.executed"
  | "file.changed"
  | "rate_limit"
  | "error";
```

Callers pass `onEvent` to receive these in order. The harness's runner uses this to write per-phase log files; you can pass your own logger or a no-op.

## What this abstraction does NOT do

- **Session persistence.** Both runners start a fresh thread per invocation (`persistSession: false` on Claude, fresh `Thread` per call on Codex). Multi-turn agent flows live at the runner-phase level, not in the SDK abstraction.
- **Authentication.** The SDKs handle their own auth — Claude via the host's `~/.claude` config, Codex via `~/.codex/auth`. The agent-runner reads neither.
- **Retries.** Rate-limit detection bubbles up via `rateLimitHit`; the *runner phase loop* (or daemon) decides what to do with it.

## Where to look

- `packages/agent-runner/src/types.ts` — interfaces and shared types.
- `packages/agent-runner/src/claude-runner.ts` — Claude SDK implementation.
- `packages/agent-runner/src/codex-runner.ts` — Codex SDK implementation.
- `packages/agent-runner/src/completion.ts` — `CompletionClient` adapter.
- `packages/agent-runner/src/factory.ts` — `createAgentRunner`.
