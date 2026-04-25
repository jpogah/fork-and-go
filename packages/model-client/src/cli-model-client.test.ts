import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CliModelClientError,
  createCliModelClient,
  type SpawnLike,
} from "./cli-model-client.ts";
import type { ModelRequest } from "./model-client.ts";

// Records the last spawn invocation so assertions can inspect arguments and
// stdin payloads. The fake ChildProcess honors close / error / kill + exposes
// stdin/stdout/stderr PassThroughs, which is all the client's subprocess
// handler reads from.
interface FakeChildConfig {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  // Delay before the fake emits close (ms). Set high to force the timeout
  // path. Ignored when `suppressClose` is true.
  closeAfterMs?: number;
  // Never emit close. Used to verify the timer path rejects regardless of
  // whether kill(SIGTERM) actually delivers a close.
  suppressClose?: boolean;
  // If true, throw synchronously from spawn (simulates an ENOENT-before-fork
  // style failure).
  throwOnSpawn?: Error;
  // If true, emit an "error" event asynchronously (simulates ENOENT bubbling
  // via the async `error` event that node:child_process raises when the
  // command is not found on PATH).
  errorAfterMs?: number;
  errorMessage?: string;
}

interface FakeSpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
  stdinWritten: string;
  killed: boolean;
}

function makeFakeSpawn(config: FakeChildConfig): {
  spawnFn: SpawnLike;
  record: FakeSpawnRecord;
} {
  const record: FakeSpawnRecord = {
    command: "",
    args: [],
    options: {},
    stdinWritten: "",
    killed: false,
  };

  const spawnFn: SpawnLike = (cmd, args, options) => {
    if (config.throwOnSpawn) throw config.throwOnSpawn;
    record.command = cmd;
    record.args = args;
    record.options = options;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      record.stdinWritten += chunk.toString("utf8");
    });

    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      record.killed = true;
      return true;
    };

    setImmediate(() => {
      if (config.stdout) stdout.write(config.stdout);
      if (config.stderr) stderr.write(config.stderr);
      stdout.end();
      stderr.end();
    });

    if (config.errorAfterMs !== undefined) {
      setTimeout(() => {
        child.emit("error", new Error(config.errorMessage ?? "spawn ENOENT"));
      }, config.errorAfterMs);
    }

    if (!config.suppressClose) {
      setTimeout(() => {
        child.emit("close", config.exitCode ?? 0);
      }, config.closeAfterMs ?? 5);
    }

    return child as unknown as ChildProcess;
  };

  return { spawnFn, record };
}

function happyStdout(
  text = "hello",
  usage?: {
    input: number;
    output: number;
    cached?: number;
  },
): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session.started",
      session: { model: "codex-default" },
    }),
  );
  lines.push(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
  );
  if (usage) {
    lines.push(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cached_input_tokens: usage.cached ?? 0,
        },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

const REQUEST: ModelRequest = {
  system: "you are a helper",
  messages: [{ role: "user", content: "hi" }],
  model: "gpt-5.4-mini",
};

describe("createCliModelClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns codex exec with --json --model, pipes stdin, and parses stdout (AC 5)", async () => {
    const { spawnFn, record } = makeFakeSpawn({
      stdout: happyStdout("response text", { input: 10, output: 20 }),
      exitCode: 0,
    });
    const client = createCliModelClient({ spawnFn });

    const response = await client.complete(REQUEST);

    expect(record.command).toBe("codex");
    // --output-schema deliberately omitted; callers validate the JSON
    // body with their own Zod schemas downstream. Codex's schema mode
    // demands `additionalProperties: false` on every object, which
    // conflicts with the permissive-schema design intent.
    expect(record.args).not.toContain("--output-schema");
    expect(record.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(record.args).toContain("--model");
    expect(record.args[record.args.indexOf("--model") + 1]).toBe(
      "gpt-5.4-mini",
    );
    expect(record.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(record.stdinWritten).toContain("you are a helper");
    expect(record.stdinWritten).toContain("hi");
    expect(response.text).toBe("response text");
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(20);
  });

  it("sums cached_input_tokens into input token count", async () => {
    const { spawnFn } = makeFakeSpawn({
      stdout: happyStdout("ok", { input: 5, output: 7, cached: 3 }),
      exitCode: 0,
    });
    const client = createCliModelClient({ spawnFn });
    const response = await client.complete(REQUEST);
    expect(response.usage.inputTokens).toBe(8);
    expect(response.usage.outputTokens).toBe(7);
  });

  it("emits a stderr warning when codex returns no usage event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spawnFn } = makeFakeSpawn({
      stdout: happyStdout("no-usage"),
      exitCode: 0,
    });
    const client = createCliModelClient({ spawnFn });
    const response = await client.complete(REQUEST);
    expect(response.usage.inputTokens).toBe(0);
    expect(response.usage.outputTokens).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to the configured defaultModel when request.model is absent", async () => {
    const { spawnFn, record } = makeFakeSpawn({
      stdout: happyStdout("ok", { input: 1, output: 1 }),
      exitCode: 0,
    });
    const client = createCliModelClient({
      spawnFn,
      defaultModel: "custom-model",
    });
    await client.complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    const modelIdx = record.args.indexOf("--model");
    expect(record.args[modelIdx + 1]).toBe("custom-model");
  });

  it("throws CliModelClientError with stderr preserved on non-zero exit (AC 6)", async () => {
    const { spawnFn } = makeFakeSpawn({
      stdout: "",
      stderr: "auth required: run `codex login`",
      exitCode: 2,
    });
    const client = createCliModelClient({ spawnFn });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: "CliModelClientError",
      stderr: "auth required: run `codex login`",
      exitCode: 2,
      kind: "non_zero_exit",
    });
  });

  it("throws CliModelClientError with a timeout-specific message when codex runs too long (AC 7)", async () => {
    const { spawnFn, record } = makeFakeSpawn({
      suppressClose: true,
    });
    const client = createCliModelClient({ spawnFn, timeoutMs: 30 });

    let caught: unknown;
    try {
      await client.complete(REQUEST);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliModelClientError);
    const err = caught as CliModelClientError;
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/timeout of 30ms/);
    expect(record.killed).toBe(true);
  });

  it("wraps async spawn errors (ENOENT) as CliModelClientError", async () => {
    const { spawnFn } = makeFakeSpawn({
      suppressClose: true,
      errorAfterMs: 5,
      errorMessage: "spawn codex ENOENT",
    });
    const client = createCliModelClient({ spawnFn });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: "CliModelClientError",
      kind: "spawn_failed",
    });
  });

  it("wraps sync spawn throws as CliModelClientError", async () => {
    const { spawnFn } = makeFakeSpawn({
      throwOnSpawn: new Error("spawn codex ENOENT"),
    });
    const client = createCliModelClient({ spawnFn });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: "CliModelClientError",
      kind: "spawn_failed",
    });
  });

  it("throws CliModelClientError when codex output lacks an agent_message event", async () => {
    const { spawnFn } = makeFakeSpawn({
      stdout:
        JSON.stringify({ type: "turn.started" }) +
        "\n" +
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, output_tokens: 0, cached_input_tokens: 0 },
        }) +
        "\n",
      exitCode: 0,
    });
    const client = createCliModelClient({ spawnFn });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: "CliModelClientError",
      kind: "bad_output",
    });
  });
});

describe("createModelClient factory", () => {
  it("returns a CliModelClient when FORK_AND_GO_LLM_CLIENT is unset (AC 1)", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    const client = createModelClient({ env: {} });
    expect(client).toBeDefined();
    expect(typeof client.complete).toBe("function");
    // Prove it's wired to the CLI path by exercising the spawn seam.
    const { spawnFn, record } = makeFakeSpawn({
      stdout: happyStdout("ok", { input: 1, output: 1 }),
      exitCode: 0,
    });
    const wired = createModelClient({
      env: {},
      cli: { spawnFn },
    });
    await wired.complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    expect(record.command).toBe("codex");
  });

  it("returns a CliModelClient when FORK_AND_GO_LLM_CLIENT=cli (AC 2)", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    const { spawnFn, record } = makeFakeSpawn({
      stdout: happyStdout("ok", { input: 1, output: 1 }),
      exitCode: 0,
    });
    const client = createModelClient({
      env: { FORK_AND_GO_LLM_CLIENT: "cli" },
      cli: { spawnFn },
    });
    await client.complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    expect(record.command).toBe("codex");
  });

  it("returns an OpenAI client when FORK_AND_GO_LLM_CLIENT=openai + OPENAI_API_KEY is set (AC 3)", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    const fakeOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            id: "c1",
            model: "gpt-5.4-mini",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" } },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          }),
        },
      },
    };
    const client = createModelClient({
      env: { FORK_AND_GO_LLM_CLIENT: "openai", OPENAI_API_KEY: "sk-test" },
      openai: { client: fakeOpenAI },
    });
    await client.complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    expect(fakeOpenAI.chat.completions.create).toHaveBeenCalledOnce();
  });

  it("throws at construction when FORK_AND_GO_LLM_CLIENT=openai and OPENAI_API_KEY is unset (AC 4)", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    expect(() =>
      createModelClient({ env: { FORK_AND_GO_LLM_CLIENT: "openai" } }),
    ).toThrow(/FORK_AND_GO_LLM_CLIENT=openai.*OPENAI_API_KEY/);
  });

  it("rejects unknown FORK_AND_GO_LLM_CLIENT values with a clear error", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    expect(() =>
      createModelClient({ env: { FORK_AND_GO_LLM_CLIENT: "ollama" } }),
    ).toThrow(/FORK_AND_GO_LLM_CLIENT must be "cli" or "openai"/);
  });

  it("honors FORK_AND_GO_CLI_TIMEOUT_MS from env", async () => {
    const { createModelClient } = await import("./model-client-factory.ts");
    const { spawnFn, record } = makeFakeSpawn({ suppressClose: true });
    const client = createModelClient({
      env: { FORK_AND_GO_CLI_TIMEOUT_MS: "25" },
      cli: { spawnFn },
    });
    let caught: unknown;
    try {
      await client.complete({
        system: "s",
        messages: [{ role: "user", content: "u" }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliModelClientError);
    expect((caught as CliModelClientError).message).toMatch(/timeout of 25ms/);
    expect(record.killed).toBe(true);
  });
});
