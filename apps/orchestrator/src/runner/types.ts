// Types for the in-process task runner. Replaces the contract that
// scripts/run_task.sh and run_task_loop.sh exposed via spawn() exit codes.

import type { AgentRunner } from "@harness/agent-runner";
import type { HarnessConfig } from "@harness/config";

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
