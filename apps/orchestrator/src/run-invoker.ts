// In-process run invoker. Calls `runTask()` directly — no more spawning
// `./scripts/run_task.sh` as a subprocess. Keeps the existing
// InvokeRunResult shape so daemon.ts didn't have to change much.
//
// The exit-code semantics map to runTask's outcome:
//   success           → exitCode 0,    rateLimited false
//   rate-limit hit    → exitCode 2,    rateLimited true   (daemon retries)
//   any other failure → exitCode 1,    rateLimited false  (daemon blocks)

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentRunner } from "@harness/agent-runner";
import type { HarnessConfig } from "@harness/config";

import type { EventSink } from "./event-bus.ts";
import type { LogSink } from "./log-sink.ts";
import { runTask, type Phase, type RunTaskOutcome } from "./runner/index.ts";

export interface InvokeRunOptions {
  planId: string;
  repoRoot: string;
  config: HarnessConfig;
  logsDir: string;
  // When true, invoke the resume flow (re-enter review/fix loop on the
  // existing branch). Otherwise run the full `--phase all` flow.
  resume?: boolean;
  // Optional explicit phase. Defaults to "all" for fresh runs and the
  // resume path for resume runs.
  phase?: Phase;
  // Caller-supplied agent runner — primarily a test seam. Production
  // callers omit and the runner is built from config.agent.
  agentRunner?: AgentRunner;
  // Local-only mode (skip push/PR/merge). Defaults from runTask's own
  // logic (presence of git remote + gh auth).
  localOnly?: boolean;
  skipE2e?: boolean;
  dryRun?: boolean;
  now?: () => Date;
  signal?: AbortSignal;
  // Forwarded into runTask so per-run events flow to the cloud sink.
  eventSink?: EventSink;
  projectId?: string;
  // Forwarded into runTask. Cloud passes an R2 streaming sink; OSS leaves
  // undefined so runTask falls back to the file-backed default.
  logSink?: LogSink;
}

export interface InvokeRunResult {
  planId: string;
  exitCode: number;
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

export function createRunInvoker(): RunInvoker {
  let active: { logPath: string; abort: AbortController } | null = null;

  return {
    async invoke(opts) {
      if (active) {
        throw new Error(
          "RunInvoker.invoke called while a previous invocation is in flight",
        );
      }
      const now = opts.now ?? (() => new Date());
      mkdirSync(opts.logsDir, { recursive: true });
      const startedAt = now().toISOString();
      const ts = startedAt.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
      const placeholderLog = path.join(opts.logsDir, `${opts.planId}-${ts}.log`);
      writeFileSync(placeholderLog, "", "utf8");

      const abort = new AbortController();
      if (opts.signal) {
        if (opts.signal.aborted) abort.abort();
        else opts.signal.addEventListener("abort", () => abort.abort(), { once: true });
      }
      active = { logPath: placeholderLog, abort };

      let outcome: RunTaskOutcome;
      try {
        outcome = await runTask({
          taskRef: opts.planId,
          repoRoot: opts.repoRoot,
          config: opts.config,
          phase: opts.phase ?? (opts.resume ? undefined : "all"),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.agentRunner ? { agentRunner: opts.agentRunner } : {}),
          ...(opts.localOnly !== undefined ? { localOnly: opts.localOnly } : {}),
          ...(opts.skipE2e !== undefined ? { skipE2e: opts.skipE2e } : {}),
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
          ...(opts.eventSink ? { eventSink: opts.eventSink } : {}),
          ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
          ...(opts.logSink ? { logSink: opts.logSink } : {}),
        });
      } catch (err) {
        active = null;
        const finishedAt = now().toISOString();
        return {
          planId: opts.planId,
          exitCode: 1,
          signal: null,
          rateLimited: false,
          logPath: placeholderLog,
          reason: err instanceof Error ? err.message : String(err),
          startedAt,
          finishedAt,
        };
      }
      active = null;
      const finishedAt = now().toISOString();

      if (outcome.ok) {
        return {
          planId: opts.planId,
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: outcome.logPath,
          reason: "",
          startedAt,
          finishedAt,
        };
      }
      return {
        planId: opts.planId,
        exitCode: outcome.rateLimited ? 2 : 1,
        signal: null,
        rateLimited: Boolean(outcome.rateLimited),
        logPath: outcome.logPath,
        reason: outcome.reason,
        startedAt,
        finishedAt,
      };
    },
    cancelActive() {
      if (active) active.abort.abort();
    },
    activeLogPath() {
      return active?.logPath ?? null;
    },
  };
}
