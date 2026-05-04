// AgentRunner backed by @anthropic-ai/claude-agent-sdk. Streams SDK
// messages, normalizes them into AgentEvent for log writers, and
// surfaces the final assistant text + usage as AgentResult.
//
// All three modes (exec, review, complete) ride on the same `query()`
// call with different permissionMode + allowedTools. Caller's
// `outputSchema` for `complete` is forwarded as a system-prompt
// instruction since the SDK doesn't expose a typed structured-output
// slot today.

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;

export function createClaudeRunner(
  config: AgentRunnerConfig,
): AgentRunner {
  return {
    exec: (opts) => runQuery(opts, "exec", config),
    review: (opts) => runQuery(opts, "review", config),
    complete: (opts) => runQuery(opts, "complete", config),
  };
}

async function runQuery(
  opts: AgentExecOpts | AgentReviewOpts | AgentCompleteOpts,
  mode: "exec" | "review" | "complete",
  config: AgentRunnerConfig,
): Promise<AgentResult> {
  const onEvent = opts.onEvent ?? (() => {});
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 0,
  };

  const options: Options = buildOptions(opts, mode, config);
  const prompt = composePrompt(opts, mode);

  let finalMessage = "";
  let rateLimitReason: string | undefined;
  let ok = true;

  try {
    const stream = query({ prompt, options });
    for await (const message of stream as AsyncGenerator<SDKMessage, void>) {
      const evt = translateMessage(message);
      if (evt) onEvent(evt);

      if (message.type === "assistant") {
        const err = (message as { error?: string }).error;
        if (err === "rate_limit") {
          rateLimitReason = "claude rate_limit";
        }
      } else if (message.type === "result") {
        // SDKResultSuccess and SDKResultError both carry usage on
        // success; on failure we still record what came back.
        const result = message as {
          subtype: "success" | "error" | "error_max_turns" | "error_during_execution";
          result?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          total_cost_usd?: number;
          is_error?: boolean;
        };
        if (typeof result.result === "string") finalMessage = result.result;
        if (result.usage) {
          usage.inputTokens = result.usage.input_tokens ?? 0;
          usage.outputTokens = result.usage.output_tokens ?? 0;
          usage.cacheReadTokens =
            result.usage.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens =
            result.usage.cache_creation_input_tokens ?? 0;
        }
        if (typeof result.total_cost_usd === "number") {
          usage.costCents = Math.round(result.total_cost_usd * 100 * 100) / 100;
        }
        if (result.is_error) ok = false;
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

function buildOptions(
  opts: AgentExecOpts | AgentReviewOpts | AgentCompleteOpts,
  mode: "exec" | "review" | "complete",
  config: AgentRunnerConfig,
): Options {
  const base: Options = {
    cwd: opts.cwd,
    persistSession: false,
  };
  const model = opts.model ?? config.model;
  if (model) base.model = model;
  if (opts.abortSignal) {
    const ac = new AbortController();
    if (opts.abortSignal.aborted) ac.abort();
    else opts.abortSignal.addEventListener("abort", () => ac.abort(), {
      once: true,
    });
    base.abortController = ac;
  }
  if ("maxTurns" in opts && opts.maxTurns) base.maxTurns = opts.maxTurns;

  if (mode === "exec") {
    base.permissionMode = "bypassPermissions";
    if (opts.allowedTools) base.allowedTools = opts.allowedTools;
    return base;
  }
  if (mode === "review") {
    base.permissionMode = "default";
    base.allowedTools = opts.allowedTools ?? [...REVIEW_TOOLS];
    base.disallowedTools = ["Edit", "Write", "NotebookEdit"];
    return base;
  }
  // complete: no tools by default. Caller may opt back into read-only.
  base.permissionMode = "default";
  base.tools = (opts as AgentCompleteOpts).allowedTools ?? [];
  return base;
}

function composePrompt(
  opts: AgentExecOpts | AgentReviewOpts | AgentCompleteOpts,
  mode: "exec" | "review" | "complete",
): string {
  const parts: string[] = [];
  if (opts.systemPrompt) parts.push(opts.systemPrompt);
  if (mode === "complete") {
    const schema = (opts as AgentCompleteOpts).outputSchema;
    if (schema) {
      parts.push(
        `Respond with a single JSON object matching this schema. Do not call any tools. Do not wrap the JSON in markdown.\n\nSchema:\n${
          typeof schema === "string" ? schema : JSON.stringify(schema, null, 2)
        }`,
      );
    } else {
      parts.push(
        "Respond with a single JSON object. Do not call any tools. Do not wrap the JSON in markdown.",
      );
    }
  }
  parts.push(opts.prompt);
  return parts.join("\n\n");
}

function translateMessage(message: SDKMessage): AgentEvent | null {
  switch (message.type) {
    case "assistant": {
      const m = message as {
        message?: { content?: Array<{ type: string; text?: string }> };
      };
      const text = (m.message?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n");
      return { kind: "assistant.message", text, raw: message };
    }
    case "result": {
      const r = message as {
        subtype: string;
        is_error?: boolean;
        result?: string;
      };
      return {
        kind: r.is_error ? "turn.failed" : "turn.completed",
        text:
          r.subtype === "success"
            ? "turn completed"
            : `turn ended: ${r.subtype}`,
        raw: message,
      };
    }
    case "system": {
      // covers SDKSystemMessage, SDKCompactBoundaryMessage, etc.
      return { kind: "thread.started", text: "system event", raw: message };
    }
    default:
      return null;
  }
}
