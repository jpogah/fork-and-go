// AgentRunner backed by @openai/codex-sdk. Starts a fresh thread per
// invocation, streams events for the log writer, and returns the
// thread's `finalResponse` + usage as AgentResult.

import {
  Codex,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";

import type {
  AgentCompleteOpts,
  AgentEvent,
  AgentExecOpts,
  AgentResult,
  AgentReviewOpts,
  AgentRunner,
  AgentRunnerConfig,
  TokenUsage,
} from "./types.ts";

export function createCodexRunner(
  config: AgentRunnerConfig,
): AgentRunner {
  const codex = new Codex({});
  return {
    exec: (opts) => runThread(codex, opts, "exec", config),
    review: (opts) => runThread(codex, opts, "review", config),
    complete: (opts) => runThread(codex, opts, "complete", config),
  };
}

async function runThread(
  codex: Codex,
  opts: AgentExecOpts | AgentReviewOpts | AgentCompleteOpts,
  mode: "exec" | "review" | "complete",
  config: AgentRunnerConfig,
): Promise<AgentResult> {
  const onEvent = opts.onEvent ?? (() => {});

  const threadOptions: ThreadOptions = {
    workingDirectory: opts.cwd,
    sandboxMode: mode === "exec" ? "workspace-write" : "read-only",
    skipGitRepoCheck: config.skipGitRepoCheck ?? mode !== "exec",
  };
  const model = opts.model ?? config.model;
  if (model) threadOptions.model = model;
  if (config.reasoningEffort)
    threadOptions.modelReasoningEffort = config.reasoningEffort;

  const thread = codex.startThread(threadOptions);

  const turnOptions: TurnOptions = {};
  if (opts.abortSignal) turnOptions.signal = opts.abortSignal;
  if (mode === "complete") {
    const schema = (opts as AgentCompleteOpts).outputSchema;
    if (schema) turnOptions.outputSchema = schema;
  }

  const prompt = composePrompt(opts, mode);

  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 0,
  };
  let finalMessage = "";
  let rateLimitReason: string | undefined;
  let ok = true;

  try {
    const streamed = await thread.runStreamed(prompt, turnOptions);
    for await (const evt of streamed.events as AsyncGenerator<ThreadEvent>) {
      const translated = translateEvent(evt);
      if (translated) onEvent(translated);

      if (evt.type === "turn.completed") {
        applyUsage(usage, evt.usage);
      } else if (evt.type === "turn.failed") {
        ok = false;
        const msg = evt.error?.message ?? "";
        if (/rate.?limit|usage.?limit|429|throttl/i.test(msg)) {
          rateLimitReason = `codex: ${msg}`;
        }
      } else if (evt.type === "item.completed") {
        const item = evt.item;
        if (item.type === "agent_message" && typeof item.text === "string") {
          finalMessage = item.text;
        }
      } else if (evt.type === "error") {
        ok = false;
        if (/rate.?limit|usage.?limit|429|throttl/i.test(evt.message)) {
          rateLimitReason = `codex: ${evt.message}`;
        }
      }
    }
  } catch (err) {
    ok = false;
    onEvent({
      kind: "error",
      text: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return {
    message: finalMessage,
    tokensUsed: usage,
    ...(rateLimitReason ? { rateLimitHit: { reason: rateLimitReason } } : {}),
    ok,
  };
}

function applyUsage(target: TokenUsage, source: Usage): void {
  target.inputTokens = source.input_tokens ?? 0;
  target.outputTokens = source.output_tokens ?? 0;
  target.cacheReadTokens = source.cached_input_tokens ?? 0;
  // Codex doesn't split out cache-write or expose per-turn USD.
  target.cacheWriteTokens = 0;
  target.costCents = 0;
}

function composePrompt(
  opts: AgentExecOpts | AgentReviewOpts | AgentCompleteOpts,
  mode: "exec" | "review" | "complete",
): string {
  const parts: string[] = [];
  if (opts.systemPrompt) parts.push(opts.systemPrompt);
  if (mode === "review") {
    parts.push(
      "You are in read-only review mode. Do not modify any files; do not run commands that mutate state.",
    );
  } else if (mode === "complete") {
    const schema = (opts as AgentCompleteOpts).outputSchema;
    if (!schema) {
      parts.push(
        "Respond with a single JSON object. Do not wrap the JSON in markdown.",
      );
    }
  }
  parts.push(opts.prompt);
  return parts.join("\n\n");
}

function translateEvent(evt: ThreadEvent): AgentEvent | null {
  switch (evt.type) {
    case "thread.started":
      return { kind: "thread.started", text: `thread ${evt.thread_id}`, raw: evt };
    case "turn.started":
      return { kind: "turn.started", text: "turn started", raw: evt };
    case "turn.completed":
      return {
        kind: "turn.completed",
        text: `turn completed (${evt.usage.input_tokens}/${evt.usage.output_tokens} tok)`,
        raw: evt,
      };
    case "turn.failed":
      return {
        kind: "turn.failed",
        text: `turn failed: ${evt.error?.message ?? "unknown"}`,
        raw: evt,
      };
    case "item.started":
    case "item.updated":
      return null;
    case "item.completed": {
      const item = evt.item;
      if (item.type === "command_execution") {
        return {
          kind: "command.executed",
          text: `$ ${item.command} (exit=${item.exit_code ?? "?"})`,
          raw: evt,
        };
      }
      if (item.type === "file_change") {
        const summary = item.changes
          .map((c) => `${c.kind} ${c.path}`)
          .join(", ");
        return {
          kind: "file.changed",
          text: `[${item.status}] ${summary}`,
          raw: evt,
        };
      }
      if (item.type === "agent_message") {
        return {
          kind: "assistant.message",
          text: item.text,
          raw: evt,
        };
      }
      if (item.type === "reasoning") {
        return { kind: "reasoning", text: item.text, raw: evt };
      }
      return null;
    }
    case "error":
      return { kind: "error", text: evt.message, raw: evt };
    default:
      return null;
  }
}
