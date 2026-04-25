// Subprocess-based ModelClient that delegates to the Codex CLI.
//
// Fork-and-Go positioning (plan 0055): forkers install `codex`, log in, and
// the planner + fidelity-check just work — no second API key required. The
// client spawns `codex exec --json --output-schema <file> --model <model>`,
// pipes the formatted prompt to stdin, and parses the JSONL event stream on
// stdout to recover the agent's final message plus token usage.
//
// Error mapping:
//   - non-zero exit    → CliModelClientError carrying stderr
//   - timeout          → CliModelClientError with a timeout-specific message
//   - spawn failure    → CliModelClientError (e.g. ENOENT when codex is
//     missing from PATH)
//
// The temp schema file is cleaned up in a `finally` block so error paths do
// not leak artifacts in $TMPDIR.
//
// Token accounting comes from Codex's `turn.completed.usage` event; when the
// event is absent (older CLI versions, killed child) we record zeros and emit
// one stderr warning so the budget aggregator still gets a non-null record.

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "./model-client.ts";

export const DEFAULT_CLI_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_MODEL = "gpt-5.4-mini";

export type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export type CliModelClientOptions = {
  defaultModel?: string;
  timeoutMs?: number;
  // Test seam: override the subprocess spawn. Defaults to `node:child_process`
  // `spawn`.
  spawnFn?: SpawnLike;
};

export class CliModelClientError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly kind: "non_zero_exit" | "timeout" | "spawn_failed" | "bad_output";
  constructor(
    message: string,
    opts: {
      stderr?: string;
      exitCode?: number | null;
      kind?: CliModelClientError["kind"];
    } = {},
  ) {
    super(message);
    this.name = "CliModelClientError";
    this.stderr = opts.stderr ?? "";
    this.exitCode = opts.exitCode ?? null;
    this.kind = opts.kind ?? "non_zero_exit";
  }
}

export function createCliModelClient(
  options: CliModelClientOptions = {},
): ModelClient {
  const defaultModel = options.defaultModel ?? DEFAULT_CLI_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const spawnFn: SpawnLike = options.spawnFn ?? (spawn as unknown as SpawnLike);

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const model = request.model ?? defaultModel;
      const prompt = formatPrompt(request);
      const { stdout, stderr, exitCode } = await runCodex({
        spawnFn,
        model,
        prompt,
        timeoutMs,
      });
      if (exitCode !== 0) {
        throw new CliModelClientError(
          `codex exec exited with status ${exitCode ?? "unknown"}`,
          { stderr, exitCode, kind: "non_zero_exit" },
        );
      }
      const parsed = parseCodexOutput(stdout);
      if (!parsed.text) {
        throw new CliModelClientError(
          "codex exec produced no agent_message event",
          { stderr, exitCode, kind: "bad_output" },
        );
      }
      return {
        text: parsed.text,
        model: parsed.model || model,
        usage: parsed.usage,
      };
    },
  };
}

interface RunCodexOpts {
  spawnFn: SpawnLike;
  model: string;
  prompt: string;
  timeoutMs: number;
}

interface RunCodexResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCodex(opts: RunCodexOpts): Promise<RunCodexResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // Note: we intentionally do NOT pass `--output-schema <file>` to
      // codex exec. OpenAI's structured-output mode (which Codex uses
      // under the hood when a schema is given) rejects any schema that
      // does not include `additionalProperties: false` on every object —
      // a constraint that conflicts with the "permissive schema; callers
      // validate downstream" design intent of this client. Relying on
      // `--json` alone puts Codex in JSON mode without schema
      // enforcement; the planner / fidelity-check validate the response
      // against their own Zod schemas.
      child = opts.spawnFn("codex", ["exec", "--json", "--model", opts.model], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new CliModelClientError(`failed to spawn codex: ${errMessage(err)}`, {
          kind: "spawn_failed",
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may have already exited
      }
      // Reject eagerly. SIGTERM usually produces a close event shortly, but
      // we don't wait for it: the caller has a contract — timeouts surface as
      // rejections within `timeoutMs`, period.
      settle(() =>
        reject(
          new CliModelClientError(
            `codex exec exceeded timeout of ${opts.timeoutMs}ms`,
            { stderr, exitCode: null, kind: "timeout" },
          ),
        ),
      );
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settle(() =>
        reject(
          new CliModelClientError(`failed to spawn codex: ${errMessage(err)}`, {
            stderr,
            kind: "spawn_failed",
          }),
        ),
      );
    });
    child.on("close", (code) => {
      if (timedOut) return; // timer already rejected
      settle(() => resolve({ stdout, stderr, exitCode: code }));
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        // Swallow EPIPE when codex closes stdin early; the close handler
        // surfaces the real failure via exit code + stderr.
      });
      try {
        child.stdin.end(opts.prompt);
      } catch {
        // Same rationale as above — let `close` deliver the actual error.
      }
    }
  });
}

function formatPrompt(req: ModelRequest): string {
  const sections: string[] = [];
  if (req.system.trim().length > 0) {
    sections.push(`[system]\n${req.system}`);
  }
  for (const msg of req.messages) {
    sections.push(`[${msg.role}]\n${msg.content}`);
  }
  return sections.join("\n\n") + "\n";
}

interface CodexParsed {
  text: string;
  model: string;
  usage: ModelUsage;
}

function parseCodexOutput(stdout: string): CodexParsed {
  let text = "";
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "turn.completed") {
      const usage = event.usage as
        | {
            input_tokens?: unknown;
            cached_input_tokens?: unknown;
            output_tokens?: unknown;
          }
        | undefined;
      if (usage) {
        inputTokens +=
          toNum(usage.input_tokens) + toNum(usage.cached_input_tokens);
        outputTokens += toNum(usage.output_tokens);
        sawUsage = true;
      }
    }
    if (type === "item.completed") {
      const item = event.item as { type?: unknown; text?: unknown } | undefined;
      if (
        item &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        text = item.text;
      }
    }
    if (!model) {
      if (typeof event.model === "string") {
        model = event.model;
      } else {
        const session = event.session as { model?: unknown } | undefined;
        if (session && typeof session.model === "string") {
          model = session.model;
        }
      }
    }
  }
  if (!sawUsage) {
    // One-line warning on the first run that lacks usage. The budget
    // aggregator reads zeros fine; this is just a visibility breadcrumb.
    console.warn(
      "[cli-model-client] codex stdout had no turn.completed.usage event; recording zeros",
    );
  }
  return {
    text,
    model,
    usage: {
      inputTokens,
      outputTokens,
      // Cost parity with the OpenAI-API path is out of scope for plan 0055
      // (see Decision Log). Zero keeps the budget aggregator's math stable
      // without claiming synthetic cost figures.
      costCents: 0,
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
