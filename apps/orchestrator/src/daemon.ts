// Orchestrator daemon main loop. Stitches together state persistence, the
// merge detector, the run invoker, the control server, and the plan-file
// transitions into the operator-facing unit.
//
// Lifecycle:
//   1. validate the plan graph; refuse to start on failure
//   2. load or create state (starts `paused` on first run)
//   3. start the control server
//   4. enter the tick loop — on each tick, poll for merges, then if not
//      paused and no plan is active, pick the next eligible plan and run it
//   5. on SIGINT/SIGTERM, transition to `stopping` and finish the active
//      plan before exiting
//
// All transitions go through the state store's atomic writer, so a hard
// kill (SIGKILL) between transitions leaves the state file consistent.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  loadPlans,
  loadPlanFile,
  nextEligiblePlans,
  validateGraph,
  formatIssue,
  type Plan,
} from "@fork-and-go/plan-graph";
import {
  freeze as freezeOrchestrator,
  isFrozen,
  readFreezeNote,
  unfreeze as unfreezeOrchestrator,
} from "@fork-and-go/run-budget";

import {
  createBudgetManager,
  defaultTaskRunsDir,
  type BudgetManager,
  type BudgetSnapshot,
} from "./budget.ts";
import { createControlServer, type ControlServer } from "./control-server.ts";
import {
  commitAndPushMigration,
  returnToMain,
  type GitSyncResult,
} from "./git-sync.ts";
import { createStdoutLogger, type Logger } from "./logger.ts";
import {
  createMergeDetector,
  type MergeDetector,
  type MergeDetectorOptions,
} from "./merge-detector.ts";
import { findPlanFile, markPlanCompleted } from "./plan-file-transitions.ts";
import {
  createRunInvoker,
  type RunInvoker,
  type InvokeRunResult,
} from "./run-invoker.ts";
import {
  createStateStore,
  type OrchestratorState,
  type StateStore,
} from "./state.ts";

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;

export interface FidelityHookResult {
  ok: boolean;
  reason?: string;
  score?: number;
  threshold?: number;
  reportPath?: string;
}

export type FidelityHook = (context: {
  mergesSinceLast: number;
  totalMerges: number;
}) => Promise<FidelityHookResult>;

// Plan 0054: release-gate hook. Fires after every observed merge. A passing
// result writes `.orchestrator/RELEASE_READY` and pauses the daemon — the
// operator manually triggers production deploy. A failing (or errored)
// result is silent on purpose: "not ready yet" is the normal case, not
// signal.
export interface ReleaseGateHookResult {
  passed: boolean;
  specPath?: string;
  reportPath?: string;
  reason?: string;
}

export type ReleaseGateHook = (context: {
  mergesSinceLast: number;
  totalMerges: number;
}) => Promise<ReleaseGateHookResult>;

export interface DaemonOptions {
  repoRoot: string;
  activeDir?: string;
  completedDir?: string;
  stateDir?: string;
  logsDir?: string;
  taskRunsDir?: string;
  runTaskScript?: string;
  runTaskLoopScript?: string;
  port?: number;
  host?: string;
  tickMs?: number;
  rateLimitBackoffMs?: number;
  maxRateLimitRetries?: number;
  // Plan 0053: fidelity check cadence. When > 0, the daemon triggers
  // `fidelityHook` after every N observed merges. When the hook returns
  // `{ ok: false }`, the daemon pauses and records a `fidelity_blocked`
  // history event. When unset or 0, no check runs.
  fidelityCheckEveryNPlans?: number;
  fidelityHook?: FidelityHook;
  // Plan 0054: release-gate hook. Fires once per observed merge when set;
  // a passing result writes `.orchestrator/RELEASE_READY` and pauses the
  // daemon. Failing results are silent (normal case).
  releaseGateHook?: ReleaseGateHook;
  // Budget (plan 0052). The ceiling defaults to 5M tokens; env override via
  // BUDGET_CEILING_TOKENS is resolved by the entry point, not here.
  tokenCeiling?: number;
  budgetWindowMs?: number;
  budget?: BudgetManager;
  logger?: Logger;
  now?: () => Date;
  mergeDetector?: MergeDetector;
  mergeDetectorOptions?: MergeDetectorOptions;
  runInvoker?: RunInvoker;
  // When true, skip the plan-graph validation gate. Tests flip this on
  // when they drive the daemon against a fixture graph that intentionally
  // isn't the repo's real graph.
  skipStartupValidation?: boolean;
  // When true, don't register signal handlers. Tests turn this off so
  // they can own the process lifecycle.
  registerSignalHandlers?: boolean;
  // Extra arguments to forward to run_task.sh. Defaults to none (the
  // runner applies its own defaults including `--phase all`).
  runTaskExtraArgs?: readonly string[];
  // Sleep helper so tests can fast-forward through the rate-limit backoff.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  // Git bridge for the plan-file migration on success. Defaults to the real
  // `returnToMain` / `commitAndPushMigration` helpers; tests pass a stub
  // because their scaffolded repos aren't initialized as git repos.
  gitSync?: GitSyncBridge;
  // Branch the daemon returns to before doing the plan-file migration.
  // Defaults to "main" (matches `run_task.sh`'s BASE_BRANCH).
  mainBranch?: string;
}

export interface GitSyncBridge {
  returnToMain(repoRoot: string, mainBranch: string): GitSyncResult;
  commitAndPushMigration(
    repoRoot: string,
    paths: readonly string[],
    commitMessage: string,
    mainBranch: string,
  ): GitSyncResult;
}

export interface Daemon {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  unblock(planId: string): { ok: boolean; reason?: string };
  freeze(reason?: string): { ok: boolean };
  unfreeze(): { ok: boolean };
  getSnapshot(): DaemonSnapshot;
  // Exposed for tests: advance one tick of the main loop synchronously.
  tickOnce(): Promise<void>;
  // Exposed for tests: wait until the current tick loop is idle (no active
  // plan run, no in-flight invocation).
  waitIdle(): Promise<void>;
}

export interface DaemonSnapshot {
  // Wire-contract field name locked by the 0050 acceptance criteria
  // (`{"state":"paused",…}` / `{"state":"running",…}`). Internally the
  // store still persists this as `OrchestratorState.mode` — the rename
  // only applies to the HTTP surface.
  state: OrchestratorState["mode"];
  activePlan: string | null;
  activeStartedAt: string | null;
  history: OrchestratorState["history"];
  blocked: OrchestratorState["blocked"];
  runsFired: number;
  lastMergeSha: string | null;
  port: number | null;
  // Plan 0052: budget + freeze surface.
  frozen: boolean;
  freezeReason: string | null;
  budget: BudgetSnapshot;
}

export async function createDaemon(opts: DaemonOptions): Promise<Daemon> {
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? createStdoutLogger(now);
  const activeDir =
    opts.activeDir ?? path.join(opts.repoRoot, "docs/exec-plans/active");
  const completedDir =
    opts.completedDir ?? path.join(opts.repoRoot, "docs/exec-plans/completed");
  const stateDir = opts.stateDir ?? path.join(opts.repoRoot, ".orchestrator");
  const logsDir = opts.logsDir ?? path.join(stateDir, "logs");
  const taskRunsDir = opts.taskRunsDir ?? defaultTaskRunsDir(opts.repoRoot);
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const budget: BudgetManager =
    opts.budget ??
    createBudgetManager({
      stateDir,
      taskRunsDir,
      now,
      ...(opts.tokenCeiling !== undefined
        ? { defaultCeilingTokens: opts.tokenCeiling }
        : {}),
      ...(opts.budgetWindowMs !== undefined
        ? { windowMs: opts.budgetWindowMs }
        : {}),
    });
  const rateLimitBackoffMs =
    opts.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const maxRateLimitRetries =
    opts.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  const sleepFn = opts.sleep ?? defaultSleep;
  const runTaskExtraArgs = opts.runTaskExtraArgs ?? [];
  const mainBranch = opts.mainBranch ?? "main";
  const gitSync: GitSyncBridge = opts.gitSync ?? {
    returnToMain,
    commitAndPushMigration,
  };

  if (!opts.skipStartupValidation) {
    validateGraphOrThrow(activeDir, completedDir);
  }

  const store: StateStore = createStateStore({ dir: stateDir, now });
  const invoker: RunInvoker = opts.runInvoker ?? createRunInvoker();
  const detector: MergeDetector =
    opts.mergeDetector ?? createMergeDetector(opts.mergeDetectorOptions);

  const fidelityEveryN = opts.fidelityCheckEveryNPlans ?? 0;
  const fidelityHook = opts.fidelityHook;
  const releaseGateHook = opts.releaseGateHook;

  // Aborted only on /stop so any in-flight rate-limit sleep wakes up — never
  // passed to the run invoker, because /stop is a graceful shutdown that lets
  // the active child finish naturally.
  const sleepAbortController = new AbortController();
  let tickTimer: NodeJS.Timeout | null = null;
  let tickPromise: Promise<void> = Promise.resolve();
  let stopping = false;
  // Plan 0053: count of merges observed since the last fidelity check. Held
  // in memory only — a daemon restart resets the count, which is fine: the
  // hook is advisory, and a missed check just runs on the next merge burst.
  let mergesSinceFidelityCheck = 0;
  let totalMergesObserved = 0;
  let fidelityCheckInFlight = false;
  // Plan 0054: release-gate hook bookkeeping. In-memory only — `.orchestrator/
  // RELEASE_READY` is the durable signal. A restart re-checks on the next
  // merge, which is the right behavior: the gate is cheap (coverage-only).
  let mergesSinceReleaseGate = 0;
  let releaseGateInFlight = false;
  let stopResolved: (() => void) | null = null;
  let stopPromise: Promise<void> = Promise.resolve();
  let controlServer: ControlServer | null = null;
  // Plan id queued for re-invocation on the next eligible tick after the
  // daemon recovered an in-progress plan from a prior crash. Sourced from
  // `state.active` at boot, then cleared once we've kicked the loop variant
  // for it. Held in memory only — `state.active` is the durable source of
  // truth; if we crash again before recovery completes, the next boot reads
  // it back the same way.
  let pendingRecoveryPlanId: string | null = null;

  const daemon: Daemon = {
    async start() {
      // Reconcile state from the previous run (which may have ended via
      // SIGKILL or a graceful /stop):
      //  1. If `state.active` is set, queue the plan for re-invocation via
      //     the resume path. `run_task_loop.sh` knows how to pick up from
      //     whatever the branch already has on disk.
      //  2. Always clamp `mode` to `paused` per the locked decision — every
      //     boot starts paused so the operator opts in via /resume. This also
      //     clears a stale `stopping` left over by /stop.
      const bootState = store.get();
      if (bootState.active) {
        const planId = bootState.active.planId;
        pendingRecoveryPlanId = planId;
        logger.log({
          event: "resume_active_on_boot",
          planId,
          branch: bootState.active.branch,
        });
        store.update((draft) => {
          draft.active = null;
        });
      }
      if (bootState.mode !== "paused") {
        store.update((draft) => {
          draft.mode = "paused";
        });
      }

      controlServer = createControlServer({
        daemon: {
          getSnapshot: () => daemon.getSnapshot(),
          pause: () => daemon.pause(),
          resume: () => daemon.resume(),
          stop: () => daemon.stop(),
          unblock: (id) => daemon.unblock(id),
          freeze: (reason) => daemon.freeze(reason),
          unfreeze: () => daemon.unfreeze(),
        },
        host: opts.host ?? "127.0.0.1",
        port: opts.port ?? 4500,
        logsDir,
      });
      const addr = await controlServer.listen();
      logger.log({
        event: "control_server_listening",
        host: addr.host,
        port: addr.port,
      });

      if (opts.registerSignalHandlers !== false) {
        const graceful = (): void => {
          logger.log({ event: "signal_received_stop" });
          void daemon.stop();
        };
        process.once("SIGINT", graceful);
        process.once("SIGTERM", graceful);
      }

      // Kick the first tick immediately so `POST /resume` directly after
      // startup triggers plan selection without a 30s delay.
      scheduleTick(0);
      return addr;
    },

    async stop() {
      if (stopping) return stopPromise;
      stopping = true;
      stopPromise = new Promise<void>((resolve) => {
        stopResolved = resolve;
      });
      store.update((draft) => {
        draft.mode = "stopping";
      });
      logger.log({ event: "stopping" });
      // Wake any in-flight rate-limit backoff sleep so /stop doesn't block
      // for a full 15-minute window. Crucially we do NOT abort the active
      // child process — /stop is graceful by contract: the in-flight plan
      // runs to completion. Operators that need a hard kill can SIGKILL the
      // daemon process directly.
      sleepAbortController.abort();
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
      try {
        await tickPromise;
      } catch {
        // swallow — tick errors are logged in-loop
      }
      if (controlServer) {
        try {
          await controlServer.close();
        } catch (err) {
          logger.log({
            event: "control_server_close_error",
            level: "warn",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The next boot's start() will clamp mode back to `paused`.
      stopResolved?.();
      logger.log({ event: "stopped" });
      return stopPromise;
    },

    pause() {
      store.update((draft) => {
        if (draft.mode !== "stopping") draft.mode = "paused";
      });
      logger.log({ event: "paused" });
    },

    resume() {
      store.update((draft) => {
        if (draft.mode === "stopping") return;
        draft.mode = draft.active ? "running" : "idle";
      });
      logger.log({ event: "resumed" });
      // Nudge the tick loop so we don't wait for the next interval.
      scheduleTick(0);
    },

    unblock(planId: string) {
      const snapshot = store.get();
      if (!snapshot.blocked[planId]) {
        return { ok: false, reason: `plan ${planId} is not blocked` };
      }
      store.update((draft) => {
        delete draft.blocked[planId];
      });
      store.pushHistory({
        planId,
        event: "graph_refreshed",
        details: { reason: "unblocked" },
      });
      logger.log({ event: "unblocked", planId });
      scheduleTick(0);
      return { ok: true };
    },

    freeze(reason?: string) {
      freezeOrchestrator(stateDir, {
        ...(reason ? { reason } : {}),
        at: now().toISOString(),
      });
      // Also pause so the next tick doesn't race a freshly-unfrozen resume.
      store.update((draft) => {
        if (draft.mode !== "stopping") draft.mode = "paused";
      });
      store.pushHistory({
        planId: null,
        event: "frozen",
        ...(reason ? { details: { reason } } : {}),
      });
      logger.log({ event: "frozen", reason: reason ?? "operator" });
      return { ok: true };
    },

    unfreeze() {
      unfreezeOrchestrator(stateDir);
      store.pushHistory({
        planId: null,
        event: "unfrozen",
      });
      logger.log({ event: "unfrozen" });
      // Stay paused — operator explicitly calls /resume to start running.
      return { ok: true };
    },

    getSnapshot() {
      const s = store.get();
      const frozen = isFrozen(stateDir);
      const freezeNote = frozen ? readFreezeNote(stateDir) : null;
      return {
        state: s.mode,
        activePlan: s.active?.planId ?? null,
        activeStartedAt: s.active?.startedAt ?? null,
        history: s.history,
        blocked: s.blocked,
        runsFired: s.runsFired,
        lastMergeSha: s.lastMergeSha,
        port: controlServer?.address()?.port ?? null,
        frozen,
        freezeReason: freezeNote?.reason ?? null,
        budget: budget.snapshot(),
      };
    },

    async tickOnce() {
      await runTick();
    },

    async waitIdle() {
      await tickPromise;
    },
  };

  function scheduleTick(delayMs: number): void {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (stopping) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      tickPromise = runTick()
        .catch((err) => {
          logger.log({
            event: "tick_error",
            level: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .then(() => {
          if (!stopping) scheduleTick(tickMs);
        });
    }, delayMs);
  }

  async function runTick(): Promise<void> {
    if (stopping) return;
    await pollMerges();
    if (stopping) return;
    await maybeStartNextPlan();
  }

  async function pollMerges(): Promise<void> {
    const current = store.get();
    try {
      const { merges, latestSha } = await detector.poll(current.lastMergeSha);
      if (latestSha !== current.lastMergeSha) {
        store.update((draft) => {
          draft.lastMergeSha = latestSha;
        });
      }
      for (const merge of merges) {
        store.pushHistory({
          planId: null,
          event: "merge_observed",
          details: {
            pr: merge.pr.number,
            sha: merge.pr.mergeCommit,
            branch: merge.pr.headRefName,
          },
        });
        logger.log({
          event: "merge_observed",
          pr: merge.pr.number,
          sha: merge.pr.mergeCommit,
          branch: merge.pr.headRefName,
        });
        mergesSinceFidelityCheck += 1;
        mergesSinceReleaseGate += 1;
        totalMergesObserved += 1;
      }
    } catch (err) {
      logger.log({
        event: "merge_poll_failed",
        level: "warn",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await maybeRunFidelityCheck();
    await maybeRunReleaseGate();
  }

  async function maybeRunFidelityCheck(): Promise<void> {
    if (stopping) return;
    // Don't burn LLM tokens while the operator is reviewing a paused daemon
    // (either a manual /pause or the auto-pause that `fidelity_blocked`
    // itself triggers). Accumulated merges are retained in memory, so the
    // next post-resume poll still sees them and the hook fires then.
    if (store.get().mode === "paused") return;
    if (!fidelityHook || fidelityEveryN <= 0) return;
    if (mergesSinceFidelityCheck < fidelityEveryN) return;
    if (fidelityCheckInFlight) return;
    fidelityCheckInFlight = true;
    const mergesThisRun = mergesSinceFidelityCheck;
    mergesSinceFidelityCheck = 0;
    try {
      const result = await fidelityHook({
        mergesSinceLast: mergesThisRun,
        totalMerges: totalMergesObserved,
      });
      if (result.ok) {
        store.pushHistory({
          planId: null,
          event: "fidelity_check_ok",
          details: {
            mergesSinceLast: mergesThisRun,
            ...(result.score !== undefined ? { score: result.score } : {}),
            ...(result.threshold !== undefined
              ? { threshold: result.threshold }
              : {}),
            ...(result.reportPath ? { reportPath: result.reportPath } : {}),
          },
        });
        logger.log({
          event: "fidelity_check_ok",
          mergesSinceLast: mergesThisRun,
          score: result.score,
          threshold: result.threshold,
        });
        return;
      }
      // Failing report: auto-pause the loop. The fidelity checker itself
      // has already blocked active plans + written the 9999 meta-plan;
      // pausing here prevents the daemon from picking up any remaining
      // eligible plan before the operator reviews.
      store.update((draft) => {
        if (draft.mode !== "paused" && draft.mode !== "stopping") {
          draft.mode = "paused";
        }
      });
      store.pushHistory({
        planId: null,
        event: "fidelity_blocked",
        details: {
          mergesSinceLast: mergesThisRun,
          reason: result.reason ?? "fidelity check failed",
          ...(result.score !== undefined ? { score: result.score } : {}),
          ...(result.threshold !== undefined
            ? { threshold: result.threshold }
            : {}),
          ...(result.reportPath ? { reportPath: result.reportPath } : {}),
        },
      });
      logger.log({
        event: "fidelity_blocked",
        level: "warn",
        mergesSinceLast: mergesThisRun,
        reason: result.reason ?? "fidelity check failed",
        score: result.score,
        threshold: result.threshold,
      });
    } catch (err) {
      // Only fires when the hook wrapper itself throws (e.g. spawn failure
      // before the checker runs). Non-zero exits from the checker — including
      // transient audit-stage errors — come back as `{ ok: false }` and go
      // through the pause-on-failure branch above, on purpose: we can't tell
      // a transient LLM timeout from a real drift failure at this layer, and
      // pausing is the safe default. Here we just restore the merge counter
      // so the next merge retries the hook.
      mergesSinceFidelityCheck += mergesThisRun;
      logger.log({
        event: "fidelity_hook_error",
        level: "warn",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      fidelityCheckInFlight = false;
    }
  }

  // Plan 0054: consults the release gate after every observed merge. A
  // passing result writes `.orchestrator/RELEASE_READY`, pushes a
  // `release_candidate_ready` history entry, and pauses the daemon. A
  // failing result is silent on purpose — "not ready yet" is the normal
  // case. Idempotent: skipped when the RELEASE_READY file already exists
  // so a restart + fresh merge doesn't re-announce.
  async function maybeRunReleaseGate(): Promise<void> {
    if (stopping) return;
    if (!releaseGateHook) return;
    if (mergesSinceReleaseGate <= 0) return;
    if (releaseGateInFlight) return;
    const readyFile = path.join(stateDir, "RELEASE_READY");
    if (existsSync(readyFile)) {
      // Already announced — clear the counter so a subsequent operator-
      // driven RELEASE_READY delete + merge re-fires cleanly.
      mergesSinceReleaseGate = 0;
      return;
    }
    releaseGateInFlight = true;
    const mergesThisRun = mergesSinceReleaseGate;
    mergesSinceReleaseGate = 0;
    try {
      const result = await releaseGateHook({
        mergesSinceLast: mergesThisRun,
        totalMerges: totalMergesObserved,
      });
      if (!result.passed) {
        // Silent: the gate failing is the expected state for most of the
        // product's lifecycle. Operators watching the daemon log see no
        // noise; failures surface via `release-gate.sh --dry-run` on
        // demand.
        return;
      }
      const at = now().toISOString();
      writeFileSync(
        readyFile,
        JSON.stringify(
          {
            at,
            specPath: result.specPath ?? null,
            reportPath: result.reportPath ?? null,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      store.update((draft) => {
        if (draft.mode !== "stopping") draft.mode = "paused";
      });
      store.pushHistory({
        planId: null,
        event: "release_candidate_ready",
        details: {
          mergesSinceLast: mergesThisRun,
          ...(result.specPath ? { specPath: result.specPath } : {}),
          ...(result.reportPath ? { reportPath: result.reportPath } : {}),
        },
      });
      logger.log({
        event: "release_candidate_ready",
        mergesSinceLast: mergesThisRun,
        specPath: result.specPath,
        reportPath: result.reportPath,
        readyFile,
      });
    } catch (err) {
      // Never crash the tick on a hook error — roll the counter back so the
      // next merge retries. Same shape as fidelity hook error handling.
      mergesSinceReleaseGate += mergesThisRun;
      logger.log({
        event: "release_gate_hook_error",
        level: "warn",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releaseGateInFlight = false;
    }
  }

  async function maybeStartNextPlan(): Promise<void> {
    const current = store.get();
    if (current.mode === "paused" || current.mode === "stopping") return;
    if (current.active) return;

    // Freeze gate (plan 0052). A file-based sentinel halts everything cleanly
    // before a new plan fires. Cheap enough to check on every tick; the
    // freeze file lives on the same disk as state.json.
    if (isFrozen(stateDir)) {
      const note = readFreezeNote(stateDir);
      logger.log({
        event: "freeze_gate_blocked",
        reason: note?.reason ?? "frozen",
      });
      store.update((draft) => {
        if (draft.mode !== "stopping") draft.mode = "paused";
      });
      return;
    }

    // Budget ceiling (plan 0052). Between-plan enforcement: a plan that
    // starts within budget is allowed to finish, but we refuse to start a
    // fresh plan once the ceiling has been crossed. Operator raises the
    // ceiling (POST or file edit) to resume.
    if (budget.isCeilingReached()) {
      const snap = budget.snapshot();
      logger.log({
        event: "budget_ceiling_reached",
        tokensUsed: snap.tokensUsed,
        tokenCeiling: snap.tokenCeiling,
        costCentsEstimated: snap.costCentsEstimated,
      });
      store.pushHistory({
        planId: null,
        event: "budget_ceiling_reached",
        details: {
          tokensUsed: snap.tokensUsed,
          tokenCeiling: snap.tokenCeiling,
          costCentsEstimated: snap.costCentsEstimated,
        },
      });
      store.update((draft) => {
        if (draft.mode !== "stopping") draft.mode = "paused";
      });
      return;
    }

    if (pendingRecoveryPlanId) {
      const planId = pendingRecoveryPlanId;
      pendingRecoveryPlanId = null;
      const plan = loadPlanById(planId);
      if (plan) {
        await runPlan(plan, { resume: true });
        return;
      }
      logger.log({
        event: "resume_active_skipped",
        level: "warn",
        planId,
        reason:
          "plan no longer present in active/ — assuming completed/aborted by hand",
      });
    }

    const plan = pickNextEligiblePlan(current);
    if (!plan) {
      if (current.mode !== "idle") {
        store.update((draft) => {
          draft.mode = "idle";
        });
      }
      return;
    }

    await runPlan(plan);
  }

  function loadPlanById(planId: string): Plan | null {
    const file = findPlanFile(activeDir, planId);
    if (!file) return null;
    try {
      return loadPlanFile(file, "active");
    } catch (err) {
      logger.log({
        event: "load_plan_failed",
        level: "error",
        planId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  function pickNextEligiblePlan(state: OrchestratorState): Plan | null {
    let plans: Plan[];
    try {
      plans = loadPlans({ activeDir, completedDir });
    } catch (err) {
      logger.log({
        event: "load_plans_failed",
        level: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const validation = validateGraph(plans);
    if (!validation.ok) {
      logger.log({
        event: "graph_invalid",
        level: "error",
        issues: validation.issues.map(formatIssue),
      });
      return null;
    }
    const eligible = nextEligiblePlans(plans);
    for (const plan of eligible) {
      // 9999* is the reserved prefix for auto-generated meta-plans (the
      // fidelity-review gate in plan 0053). They're intentional review
      // stops for a human, not build tasks — never dispatch them even if
      // every other plan is blocked and 9999 is the lone eligible id.
      if (plan.id.startsWith("9999")) continue;
      if (!state.blocked[plan.id]) return plan;
    }
    return null;
  }

  // Aggregates any new tokens-used.json records for the plan into the shared
  // budget file and logs the plan's usage. Called from handleSuccess and
  // handleBlocked so a plan that burns tokens and then fails still gets
  // charged — otherwise a planner bug that loops-and-errors could drain the
  // real provider budget without ever hitting our ceiling check.
  function aggregatePlanTokens(plan: Plan): void {
    try {
      const result = budget.aggregatePlan(plan.id, plan.estimatedPasses);
      if (result.usage.recordCount > 0 || result.ceilingReached) {
        logger.log({
          event: "plan_tokens_aggregated",
          planId: plan.id,
          tokens: result.usage.totalTokens,
          costCents: result.usage.costCents,
          tokensUsed: result.state.tokensUsed,
          tokenCeiling: result.state.tokenCeiling,
          ceilingReached: result.ceilingReached,
        });
      }
      if (result.overBudgetBy > 0) {
        logger.log({
          event: "plan_over_budget",
          level: "warn",
          planId: plan.id,
          tokens: result.usage.totalTokens,
          estimatedPasses: plan.estimatedPasses,
          overBy: result.overBudgetBy,
        });
        store.pushHistory({
          planId: plan.id,
          event: "plan_over_budget",
          details: {
            tokens: result.usage.totalTokens,
            estimatedPasses: plan.estimatedPasses,
            overBy: result.overBudgetBy,
          },
        });
      }
    } catch (err) {
      logger.log({
        event: "plan_tokens_aggregate_failed",
        level: "warn",
        planId: plan.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runPlan(
    plan: Plan,
    runOpts: { resume?: boolean } = {},
  ): Promise<void> {
    const branch = `task/${planBranchSlug(plan)}`;
    const startedAt = now().toISOString();
    const logPath = path.join(logsDir, planPlaceholderLog(plan.id, now()));

    store.update((draft) => {
      if (draft.mode !== "stopping") draft.mode = "running";
      draft.active = {
        planId: plan.id,
        branch,
        startedAt,
        logPath,
        rateLimitRetries: 0,
      };
      draft.runsFired += 1;
    });
    store.pushHistory({
      planId: plan.id,
      event: "plan_started",
      details: { branch, resume: Boolean(runOpts.resume) },
    });
    logger.log({
      event: "plan_started",
      planId: plan.id,
      branch,
      resume: Boolean(runOpts.resume),
    });

    let result: InvokeRunResult | null = null;
    let attempt = 0;
    try {
      while (true) {
        attempt += 1;
        // Recovery from a prior crash forces the loop variant on the very
        // first attempt; rate-limit retries continue using it from attempt 2
        // onward (the branch already has the prior commits).
        const useResume = Boolean(runOpts.resume) || attempt > 1;
        result = await invoker.invoke({
          planId: plan.id,
          repoRoot: opts.repoRoot,
          logsDir,
          runTaskScript: opts.runTaskScript,
          runTaskLoopScript: opts.runTaskLoopScript,
          resume: useResume,
          extraArgs: runTaskExtraArgs,
          // Intentionally no `signal` — /stop is graceful and must not
          // SIGTERM the active child.
        });
        // Persist the actual log path from the invoker so /logs/:id and
        // the blocked-reason snippet both point at the real file.
        store.update((draft) => {
          if (draft.active) draft.active.logPath = result!.logPath;
        });

        if (result.exitCode === 0 && !result.rateLimited) {
          aggregatePlanTokens(plan);
          await handleSuccess(plan.id, result);
          return;
        }

        if (result.rateLimited) {
          const state = store.get();
          const active = state.active;
          const rateLimitedAttempts = (active?.rateLimitRetries ?? 0) + 1;
          store.update((draft) => {
            if (draft.active)
              draft.active.rateLimitRetries = rateLimitedAttempts;
          });
          store.pushHistory({
            planId: plan.id,
            event: "rate_limit_backoff",
            details: {
              retries: rateLimitedAttempts,
              backoffMs: rateLimitBackoffMs,
            },
          });
          logger.log({
            event: "rate_limit_backoff",
            planId: plan.id,
            retries: rateLimitedAttempts,
            backoffMs: rateLimitBackoffMs,
          });
          // Stop retrying once we have seen maxRateLimitRetries failures in a
          // row — the plan's "fails 3 times in a row without progress, THEN
          // mark `blocked`" rule. Block before sleeping so we don't waste a
          // backoff window on a plan we've already given up on.
          if (rateLimitedAttempts >= maxRateLimitRetries) {
            aggregatePlanTokens(plan);
            await handleBlocked(plan.id, result, {
              reason: `blocked after ${maxRateLimitRetries} rate-limit retries`,
            });
            return;
          }
          // Don't enter another sleep if /stop already arrived — leaves
          // active state intact so the next boot recovers this plan.
          if (stopping) return;
          try {
            await sleepFn(rateLimitBackoffMs, sleepAbortController.signal);
          } catch (err) {
            if (isAbortError(err)) {
              logger.log({
                event: "rate_limit_backoff_aborted",
                planId: plan.id,
              });
              return;
            }
            throw err;
          }
          if (stopping) return;
          continue;
        }

        // Non-zero exit without rate-limit → block immediately.
        aggregatePlanTokens(plan);
        await handleBlocked(plan.id, result);
        return;
      }
    } catch (err) {
      logger.log({
        event: "plan_invocation_error",
        level: "error",
        planId: plan.id,
        error: err instanceof Error ? err.message : String(err),
      });
      store.update((draft) => {
        draft.active = null;
        draft.blocked[plan.id] = {
          reason: err instanceof Error ? err.message : String(err),
          blockedAt: now().toISOString(),
          retries: attempt,
        };
        draft.mode = draft.mode === "running" ? "idle" : draft.mode;
      });
      store.pushHistory({
        planId: plan.id,
        event: "plan_blocked",
        details: {
          reason: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async function handleSuccess(
    planId: string,
    result: InvokeRunResult,
  ): Promise<void> {
    try {
      // Return the checkout to `main` before migrating. `run_task.sh` leaves
      // the working tree on the task branch with its own commits; writing
      // the status flip straight into that checkout would leave it dirty and
      // brick the next run's `ensure_task_branch` guard. If we can't switch
      // (e.g., the task branch itself still has uncommitted work), block the
      // plan rather than silently migrating on the wrong branch.
      const returned = gitSync.returnToMain(opts.repoRoot, mainBranch);
      if (returned.attempted && !returned.ok) {
        throw new Error(
          `cannot return to ${mainBranch} before migration: ${returned.reason ?? "unknown error"}`,
        );
      }
      if (returned.reason) {
        logger.log({
          event: "return_to_main_note",
          level: "warn",
          planId,
          note: returned.reason,
        });
      }

      const migration = markPlanCompleted(planId, {
        activeDir,
        completedDir,
      });
      // Migration may be a no-op if the file was already in completedDir
      // (PR merged a migration commit directly, or a prior run crashed
      // mid-migration); nothing to commit in that case.
      const pathsToStage =
        migration.from === migration.to
          ? [migration.to]
          : [migration.from, migration.to];
      const pushed = gitSync.commitAndPushMigration(
        opts.repoRoot,
        pathsToStage,
        `chore: mark ${planId} completed`,
        mainBranch,
      );
      if (pushed.attempted && !pushed.ok) {
        // A commit failure leaves the tree dirty on main — same blocker
        // as the original bug if we let the next tick run. Block instead.
        throw new Error(
          `migration commit failed: ${pushed.reason ?? "unknown error"}`,
        );
      }
      if (pushed.reason) {
        logger.log({
          event: "migration_commit_note",
          level: "warn",
          planId,
          note: pushed.reason,
        });
      }

      store.pushHistory({
        planId,
        event: "plan_completed",
        details: {
          from: path.relative(opts.repoRoot, migration.from),
          to: path.relative(opts.repoRoot, migration.to),
          logPath: path.relative(opts.repoRoot, result.logPath),
        },
      });
      logger.log({
        event: "plan_completed",
        planId,
        durationMs:
          new Date(result.finishedAt).getTime() -
          new Date(result.startedAt).getTime(),
      });
    } catch (err) {
      // If the migration fails (e.g., destination already exists, or we
      // can't return to main), surface the failure as `blocked` so the
      // operator can intervene — do NOT silently swallow it, because the
      // graph will drift.
      store.update((draft) => {
        draft.blocked[planId] = {
          reason: `run succeeded but plan-file migration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          blockedAt: now().toISOString(),
          retries: 0,
        };
      });
      store.pushHistory({
        planId,
        event: "plan_blocked",
        details: {
          reason: "plan-file migration failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      logger.log({
        event: "plan_migration_failed",
        level: "error",
        planId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      store.update((draft) => {
        draft.active = null;
        if (draft.mode === "running") draft.mode = "idle";
      });
    }
  }

  async function handleBlocked(
    planId: string,
    result: InvokeRunResult,
    override?: { reason?: string },
  ): Promise<void> {
    const reason =
      override?.reason ??
      (result.reason || `run_task.sh exited with code ${result.exitCode}`);
    store.update((draft) => {
      draft.active = null;
      draft.blocked[planId] = {
        reason,
        blockedAt: now().toISOString(),
        retries: draft.blocked[planId]?.retries ?? 0,
      };
      if (draft.mode === "running") draft.mode = "idle";
    });
    store.pushHistory({
      planId,
      event: "plan_blocked",
      details: {
        reason,
        exitCode: result.exitCode,
        logPath: path.relative(opts.repoRoot, result.logPath),
      },
    });
    logger.log({
      event: "plan_blocked",
      planId,
      reason,
      exitCode: result.exitCode,
    });
  }

  return daemon;
}

function planBranchSlug(plan: Plan): string {
  const base = path.basename(plan.filePath, ".md");
  // filenames are canonical `<id>-<slug>.md`, so the slug is everything
  // after the first four digits + dash.
  return base;
}

function planPlaceholderLog(planId: string, at: Date): string {
  const ts = at
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return `${planId}-${ts}.log`;
}

function validateGraphOrThrow(activeDir: string, completedDir: string): void {
  if (!existsSync(activeDir) || !existsSync(completedDir)) {
    throw new Error(
      `Orchestrator cannot start: missing plan directories (${activeDir} or ${completedDir}).`,
    );
  }
  const plans = loadPlans({ activeDir, completedDir });
  const validation = validateGraph(plans);
  if (!validation.ok) {
    const issues = validation.issues.map(formatIssue).join("\n  - ");
    throw new Error(
      `Orchestrator refusing to start: plan graph is invalid:\n  - ${issues}`,
    );
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
