// Spawns `./scripts/run_task.sh <id>` (or the loop variant for resume) as a
// child process, tees stdout+stderr to a per-plan log file, and resolves
// with the exit code plus a rate-limit flag once the process exits.

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

import {
  scanLogForRateLimit,
  tailReason,
  type RateLimitScanOptions,
} from "./rate-limit-detector.ts";

// Time to wait after SIGTERM before escalating to SIGKILL on cancellation.
// A wedged claude CLI or stuck node subprocess that ignores SIGTERM would
// otherwise leave invoke() unresolved indefinitely, hanging any caller that
// awaits it (e.g., daemon.stop()).
export const KILL_ESCALATION_MS = 10_000;

export interface InvokeRunOptions {
  planId: string;
  repoRoot: string;
  logsDir: string;
  runTaskScript?: string;
  runTaskLoopScript?: string;
  // When true, invoke run_task_loop.sh (resume-from-disk flow). Otherwise
  // invoke run_task.sh --phase all for a fresh run.
  resume?: boolean;
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  signal?: AbortSignal;
  rateLimitScan?: RateLimitScanOptions;
  // Hook for tests: swap the real spawn() with a fake. Returns a process-like
  // object exposing stdout/stderr streams + an `on("exit", cb)` listener.
  spawnFn?: typeof spawn;
}

export interface InvokeRunResult {
  planId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  rateLimited: boolean;
  logPath: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunInvoker {
  invoke(opts: InvokeRunOptions): Promise<InvokeRunResult>;
  cancelActive(): void;
  activeLogPath(): string | null;
}

interface PipedChild extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

export function createRunInvoker(): RunInvoker {
  let active: {
    child: PipedChild;
    logPath: string;
  } | null = null;

  return {
    async invoke(opts) {
      if (active) {
        throw new Error(
          "RunInvoker.invoke called while a previous invocation is in flight",
        );
      }
      const now = opts.now ?? (() => new Date());
      mkdirSync(opts.logsDir, { recursive: true });
      const ts = now()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .replace("Z", "");
      const logPath = path.join(opts.logsDir, `${opts.planId}-${ts}.log`);
      const logStream = createWriteStream(logPath, { flags: "a" });
      const startedAt = now().toISOString();

      const script = opts.resume
        ? (opts.runTaskLoopScript ?? "./scripts/run_task_loop.sh")
        : (opts.runTaskScript ?? "./scripts/run_task.sh");
      const args = [opts.planId, ...(opts.extraArgs ?? [])];

      const spawnFn = opts.spawnFn ?? spawn;
      const child = spawnFn(script, args, {
        cwd: opts.repoRoot,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as PipedChild;

      active = { child, logPath };

      const startLine = `[orchestrator] invoking ${script} ${args.join(" ")}\n`;
      logStream.write(startLine);

      child.stdout.on("data", (chunk) => {
        logStream.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        logStream.write(chunk);
      });

      const onAbort = (): void => {
        terminateChild(child);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      return await new Promise<InvokeRunResult>((resolve, reject) => {
        child.once("error", (err) => {
          logStream.end(`[orchestrator] spawn error: ${err.message}\n`);
          active = null;
          if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.once("exit", (code, signal) => {
          const endLine = `[orchestrator] child exited code=${code} signal=${signal}\n`;
          logStream.end(endLine, () => {
            const finishedAt = now().toISOString();
            const rateLimited = scanLogForRateLimit(
              logPath,
              opts.rateLimitScan,
            );
            const reason = rateLimited
              ? "Claude usage limit hit"
              : code === 0
                ? ""
                : tailReason(logPath);
            active = null;
            if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
            resolve({
              planId: opts.planId,
              exitCode: code,
              signal,
              rateLimited,
              logPath,
              reason,
              startedAt,
              finishedAt,
            });
          });
        });
      });
    },
    cancelActive() {
      if (active) terminateChild(active.child);
    },
    activeLogPath() {
      return active?.logPath ?? null;
    },
  };
}

// SIGTERM the child, then escalate to SIGKILL after KILL_ESCALATION_MS if it
// hasn't exited. The escalation timer is unref'd so it never holds the event
// loop open on its own.
function terminateChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_ESCALATION_MS);
  timer.unref();
}
