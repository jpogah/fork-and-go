// Types for the in-process task runner. Replaces the contract that
// scripts/run_task.sh and run_task_loop.sh exposed via spawn() exit codes.

import type { AgentRunner } from "@harness/agent-runner";
import type { HarnessConfig, SecretsProvider } from "@harness/config";

import type { EventSink } from "../event-bus.ts";
import type { LogSink } from "../log-sink.ts";

export type Phase =
  | "all"
  | "implement"
  | "review"
  | "review-ui"
  | "fix"
  | "prepare-pr"
  | "e2e-verify"
  | "merge-check";

export interface RunTaskOptions {
  taskRef: string;
  repoRoot: string;
  config: HarnessConfig;
  phase?: Phase;
  // When true, skip a fresh implementation and resume the review/fix loop
  // against the branch as it stands on disk (the run_task_loop.sh flow).
  resume?: boolean;
  // When true, skip push, PR, and merge operations.
  localOnly?: boolean;
  // When true, skip the e2e-verify gate. Use for plans tagged non-UI-touching.
  skipE2e?: boolean;
  // Hard cap on review/fix passes. Defaults to config.agent.maxReviewPasses.
  maxReviewPasses?: number;
  // When true, log actions without executing the agent or git.
  dryRun?: boolean;
  // Pre-built runner — primarily for tests; production callers omit and we
  // build one from config.agent.
  agentRunner?: AgentRunner;
  // Optional logger; defaults to writing to .orchestrator/logs/<plan>.log
  logger?: (line: string) => void;
  // Optional structured-event sink. Defaults to no-op. The cloud passes a
  // webhook poster that pushes events to its API for tenant-side fan-out.
  eventSink?: EventSink;
  // Optional project identifier stamped onto every event the run emits.
  // The cloud sets this; OSS leaves it undefined.
  projectId?: string;
  // Optional log sink. Defaults to a file-backed sink at
  // `<stateDir>/logs/<plan>-<runId>.log`. The cloud passes an R2-streaming
  // sink that flushes batches to object storage as the run progresses.
  logSink?: LogSink;
  // Optional secrets provider. The runner queries it for ANTHROPIC_API_KEY
  // / OPENAI_API_KEY / GH_TOKEN and sets them in the child env before the
  // agent SDK is invoked. Defaults to reading process.env, which preserves
  // OSS behavior. The cloud passes a vault-backed provider that decrypts
  // the project's BYO keys per-run.
  secrets?: SecretsProvider;
}

export type RunTaskOutcome =
  | {
      ok: true;
      planId: string;
      branch: string;
      runDir: string;
      logPath: string;
      phasesRun: Phase[];
      tokensTotal: { inputTokens: number; outputTokens: number };
    }
  | {
      ok: false;
      planId: string;
      branch: string;
      runDir: string;
      logPath: string;
      reason: string;
      // Set when the run aborted because the agent SDK reported a
      // rate-limit / usage-limit failure. The orchestrator daemon uses this
      // to decide whether to back off and resume.
      rateLimited?: boolean;
    };

export interface RunContext {
  // Resolved plan info.
  planId: string;
  planSlug: string;
  planPath: string;
  planRel: string;
  planTitle: string;
  planPhase: string;
  branch: string;
  // Filesystem locations.
  repoRoot: string;
  runDir: string;
  runId: string;
  logPath: string;
  // Configuration knobs.
  config: HarnessConfig;
  baseBranch: string;
  localOnly: boolean;
  skipE2e: boolean;
  maxReviewPasses: number;
  dryRun: boolean;
  // Bound utilities.
  runner: AgentRunner;
  log: (line: string) => void;
  logSink: LogSink;
  events: EventSink;
  projectId?: string;
  // Per-phase token-usage records. Append-only.
  tokensUsed: TokensRecord[];
}

export interface TokensRecord {
  phase: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  at: string;
}
