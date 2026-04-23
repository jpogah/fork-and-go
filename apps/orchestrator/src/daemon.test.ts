import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "./daemon.ts";
import { createSilentLogger } from "./logger.ts";
import type { MergeDetector } from "./merge-detector.ts";
import type {
  InvokeRunOptions,
  InvokeRunResult,
  RunInvoker,
} from "./run-invoker.ts";

function scaffoldRepo(): {
  repoRoot: string;
  activeDir: string;
  completedDir: string;
  stateDir: string;
  logsDir: string;
} {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "orchestrator-daemon-"));
  const activeDir = path.join(repoRoot, "docs/exec-plans/active");
  const completedDir = path.join(repoRoot, "docs/exec-plans/completed");
  const stateDir = path.join(repoRoot, ".orchestrator");
  const logsDir = path.join(stateDir, "logs");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { repoRoot, activeDir, completedDir, stateDir, logsDir };
}

function writePlan(
  dir: string,
  id: string,
  opts: { status?: string; dependsOn?: string[] } = {},
): string {
  const status = opts.status ?? "active";
  const deps = opts.dependsOn ?? [];
  const depsYaml =
    deps.length === 0
      ? "depends_on: []"
      : `depends_on:\n${deps.map((d) => `  - "${d}"`).join("\n")}`;
  const file = path.join(dir, `${id}-fixture-plan.md`);
  writeFileSync(
    file,
    [
      "---",
      `id: "${id}"`,
      `title: "Fixture ${id}"`,
      'phase: "Harness"',
      `status: "${status}"`,
      depsYaml,
      "estimated_passes: 1",
      "acceptance_tags: []",
      "---",
      "",
      `# Fixture ${id}`,
      "",
      "body",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

interface FakeInvokeCall {
  planId: string;
  resume: boolean;
  extraArgs: readonly string[];
}

function stubInvoker(
  results: Array<InvokeRunResult | Error>,
  calls: FakeInvokeCall[],
): RunInvoker {
  let idx = 0;
  return {
    async invoke(opts: InvokeRunOptions) {
      calls.push({
        planId: opts.planId,
        resume: opts.resume ?? false,
        extraArgs: opts.extraArgs ?? [],
      });
      const next = results[idx];
      idx += 1;
      if (!next) {
        throw new Error(
          `stubInvoker ran out of scripted results at index ${idx - 1}`,
        );
      }
      if (next instanceof Error) throw next;
      // Ensure the scripted log path exists so path.relative() + state
      // serialization don't trip on a missing file.
      mkdirSync(path.dirname(next.logPath), { recursive: true });
      if (!existsSync(next.logPath)) {
        writeFileSync(next.logPath, "scripted log\n", "utf8");
      }
      return next;
    },
    cancelActive() {},
    activeLogPath() {
      return null;
    },
  };
}

function stubMergeDetector(): MergeDetector {
  return {
    async poll(lastMergeSha) {
      return { merges: [], latestSha: lastMergeSha };
    },
  };
}

describe("orchestrator daemon", () => {
  let daemon: Daemon | null = null;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = null;
    }
  });

  it("starts paused and exposes status via the control server", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
    });
    const addr = await daemon.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      history: unknown[];
      activePlan: string | null;
    };
    expect(body.state).toBe("paused");
    expect(body.history).toEqual([]);
    expect(body.activePlan).toBeNull();
  });

  it("picks up the next eligible plan on resume and marks it completed on success", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    writePlan(repo.activeDir, "0002", { dependsOn: ["0001"] });
    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-done.log"),
          reason: "",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
      ],
      invokeCalls,
    );
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();

    expect(invokeCalls[0]?.planId).toBe("0001");
    expect(
      existsSync(path.join(repo.completedDir, "0001-fixture-plan.md")),
    ).toBe(true);
    const completed = readFileSync(
      path.join(repo.completedDir, "0001-fixture-plan.md"),
      "utf8",
    );
    expect(completed).toMatch(/status: "completed"/);

    const snap = daemon.getSnapshot();
    expect(snap.activePlan).toBeNull();
    expect(snap.history.some((h) => h.event === "plan_completed")).toBe(true);
  });

  it("chains through multiple plans on one daemon instance without re-resuming", async () => {
    // Regression for the bug where `markPlanCompleted` wrote into the task
    // branch's working tree, leaving it dirty and causing the next tick's
    // `run_task.sh` to die at `ensure_task_branch`'s cleanliness guard.
    // Tests drive the daemon with a stub invoker + stub git bridge, but the
    // shape we exercise — plan A → plan B on one daemon — is the path that
    // regresses in production when either side misbehaves.
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    writePlan(repo.activeDir, "0002", { dependsOn: ["0001"] });
    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-done.log"),
          reason: "",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
        {
          planId: "0002",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0002-done.log"),
          reason: "",
          startedAt: "2026-04-22T00:00:10.000Z",
          finishedAt: "2026-04-22T00:00:15.000Z",
        },
      ],
      invokeCalls,
    );
    // Scripted git bridge that mimics a clean return-to-main + empty
    // commit path. The production bridge runs real git; in tests we only
    // need the contract's inputs/outputs to match.
    const gitSyncCalls: Array<{ op: string; paths?: readonly string[] }> = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
      gitSync: {
        returnToMain: () => {
          gitSyncCalls.push({ op: "returnToMain" });
          return { attempted: true, ok: true };
        },
        commitAndPushMigration: (_root, paths) => {
          gitSyncCalls.push({ op: "commit", paths });
          return { attempted: true, ok: true };
        },
      },
    });
    await daemon.start();
    daemon.resume();

    await daemon.tickOnce();
    expect(invokeCalls[0]?.planId).toBe("0001");
    expect(
      existsSync(path.join(repo.completedDir, "0001-fixture-plan.md")),
    ).toBe(true);

    // Second tick on the same daemon — no extra resume. Plan 2 must fire
    // and complete cleanly. Before the fix this would have bricked:
    // markPlanCompleted left the "task branch" dirty for a real run_task.sh.
    await daemon.tickOnce();
    expect(invokeCalls).toHaveLength(2);
    expect(invokeCalls[1]?.planId).toBe("0002");
    expect(
      existsSync(path.join(repo.completedDir, "0002-fixture-plan.md")),
    ).toBe(true);

    const snap = daemon.getSnapshot();
    expect(snap.blocked).toEqual({});
    expect(snap.activePlan).toBeNull();
    // Return-to-main ran once per successful plan, matching the fix's
    // contract that migration happens on main, not on the task branch.
    expect(gitSyncCalls.filter((c) => c.op === "returnToMain")).toHaveLength(2);
  });

  it("treats an already-migrated plan file as a successful no-op (idempotent)", async () => {
    // If a prior orchestrator crashed between the rename and the state
    // write, or the PR itself moved the plan file, a fresh success must
    // not flip the plan to `blocked`. markPlanCompleted returns a no-op
    // migration result, handleSuccess commits nothing, and the daemon
    // records plan_completed.
    const repo = scaffoldRepo();
    // Plan starts already in completedDir. active/ has no matching file.
    writeFileSync(
      path.join(repo.completedDir, "0001-fixture-plan.md"),
      [
        "---",
        'id: "0001"',
        'title: "Fixture 0001"',
        'phase: "Harness"',
        'status: "completed"',
        "depends_on: []",
        "estimated_passes: 1",
        "acceptance_tags: []",
        "---",
        "",
        "# Fixture 0001",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
    // Seed state.active so the boot recovery path fires the invoker
    // against this id without needing it in active/.
    writeFileSync(
      path.join(repo.stateDir, "state.json"),
      JSON.stringify({
        version: 1,
        mode: "paused",
        lastMergeSha: null,
        active: {
          planId: "0001",
          branch: "task/0001-fixture",
          startedAt: "2026-04-22T00:00:00.000Z",
          logPath: path.join(repo.logsDir, "0001-old.log"),
          rateLimitRetries: 0,
        },
        blocked: {},
        history: [],
        runsFired: 0,
      }),
      "utf8",
    );
    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-done.log"),
          reason: "",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
      ],
      invokeCalls,
    );
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
      // Recovery path relies on findPlanFile hitting active/. The fixture
      // plan is already in completed/, so the recovery branch in the
      // daemon will log "resume_active_skipped" — that's fine; we exercise
      // the idempotency separately via markPlanCompleted below.
    });
    await daemon.start();
    // Directly exercise the idempotent path. The daemon's internal call
    // would hit the same code on handleSuccess.
    const { markPlanCompleted } = await import("./plan-file-transitions.ts");
    const migration = markPlanCompleted("0001", {
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
    });
    // No-op migration: src is reported equal to dest so handleSuccess can
    // detect it and skip the (empty) commit.
    expect(migration.from).toBe(migration.to);
    expect(migration.to).toMatch(/0001-fixture-plan\.md$/);
  });

  it("blocks a plan when run_task.sh exits non-zero without a rate limit", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const invokeCalls: FakeInvokeCall[] = [];
    const logPath = path.join(repo.logsDir, "0001-fail.log");
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 1,
          signal: null,
          rateLimited: false,
          logPath,
          reason: "preflight failed on typecheck",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
      ],
      invokeCalls,
    );
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();

    const snap = daemon.getSnapshot();
    expect(snap.blocked["0001"]).toBeDefined();
    expect(snap.blocked["0001"]?.reason).toMatch(/preflight failed/);
    expect(snap.activePlan).toBeNull();
    expect(
      existsSync(path.join(repo.completedDir, "0001-fixture-plan.md")),
    ).toBe(false);
  });

  it("retries on rate-limit, then blocks after exhausting retries", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const invokeCalls: FakeInvokeCall[] = [];
    const result = (n: number): InvokeRunResult => ({
      planId: "0001",
      exitCode: 1,
      signal: null,
      rateLimited: true,
      logPath: path.join(repo.logsDir, `0001-rl-${n}.log`),
      reason: "Claude usage limit hit",
      startedAt: "2026-04-22T00:00:00.000Z",
      finishedAt: "2026-04-22T00:00:05.000Z",
    });
    const invoker = stubInvoker([result(1), result(2), result(3)], invokeCalls);

    const sleepCalls: number[] = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      rateLimitBackoffMs: 15 * 60_000,
      maxRateLimitRetries: 3,
      // Collapse the 15-minute sleep to a no-op so tests stay fast.
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();

    // 3 rate-limited attempts total: initial + 2 retries. Block on the 3rd
    // failure without another sleep.
    expect(invokeCalls).toHaveLength(3);
    expect(invokeCalls[0]?.resume).toBe(false);
    expect(invokeCalls[1]?.resume).toBe(true);
    expect(invokeCalls[2]?.resume).toBe(true);
    expect(sleepCalls).toEqual([15 * 60_000, 15 * 60_000]);

    const snap = daemon.getSnapshot();
    expect(snap.blocked["0001"]).toBeDefined();
    expect(snap.blocked["0001"]?.reason).toMatch(/rate-limit retries/);
    expect(
      snap.history.filter((h) => h.event === "rate_limit_backoff"),
    ).toHaveLength(3);
  });

  it("recovers an in-progress plan after a hard kill: clamps to paused, then re-fires via the loop variant on /resume", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const stateFile = path.join(repo.stateDir, "state.json");
    // Pretend a previous run left in-progress state behind (e.g., SIGKILL or
    // /stop while the plan was mid-flight). Note `mode: "stopping"` — a
    // graceful /stop persists this on disk; the boot path must not honor it
    // verbatim or /resume gets bricked.
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        mode: "stopping",
        lastMergeSha: "sha-abc",
        active: {
          planId: "0001",
          branch: "task/0001-fixture",
          startedAt: "2026-04-22T00:00:00.000Z",
          logPath: path.join(repo.logsDir, "0001-old.log"),
          rateLimitRetries: 1,
        },
        blocked: {},
        history: [
          {
            planId: "0001",
            event: "plan_started",
            at: "2026-04-22T00:00:00.000Z",
          },
        ],
        runsFired: 1,
      }),
      "utf8",
    );

    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-recovered.log"),
          reason: "",
          startedAt: "2026-04-22T00:01:00.000Z",
          finishedAt: "2026-04-22T00:01:05.000Z",
        },
      ],
      invokeCalls,
    );

    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    const snap = daemon.getSnapshot();
    // Boot clamps state to paused per the locked decision (no surprise
    // auto-resume) AND clears the stale `stopping` so /resume isn't bricked.
    expect(snap.state).toBe("paused");
    // active is cleared on boot — the recovered plan is queued in memory and
    // fires on the next eligible tick.
    expect(snap.activePlan).toBeNull();
    // Counters and merge cursor survive the cold boot.
    expect(snap.runsFired).toBe(1);
    expect(snap.lastMergeSha).toBe("sha-abc");

    daemon.resume();
    await daemon.tickOnce();

    // Recovery: the recovered plan was re-fired via the loop variant first,
    // not the fresh `run_task.sh` path.
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]?.planId).toBe("0001");
    expect(invokeCalls[0]?.resume).toBe(true);
    // And the recovery run completed cleanly, so the plan migrates to
    // completed/.
    expect(
      existsSync(path.join(repo.completedDir, "0001-fixture-plan.md")),
    ).toBe(true);
  });

  it("graceful /stop waits for the in-flight plan to finish — does not cancel the child", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");

    let resolveInvoke: ((r: InvokeRunResult) => void) | null = null;
    let cancelCount = 0;
    const invoker: RunInvoker = {
      async invoke(opts: InvokeRunOptions) {
        return new Promise<InvokeRunResult>((resolve) => {
          resolveInvoke = (r) => {
            mkdirSync(path.dirname(r.logPath), { recursive: true });
            if (!existsSync(r.logPath)) {
              writeFileSync(r.logPath, "scripted log\n", "utf8");
            }
            resolve(r);
          };
          // Reference opts so TS doesn't flag it unused.
          void opts;
        });
      },
      cancelActive() {
        cancelCount += 1;
      },
      activeLogPath() {
        return null;
      },
    };

    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    // Run the tick in the background — invoker.invoke will park here until
    // we manually resolveInvoke().
    const tickPromise = daemon.tickOnce();
    // Wait until the daemon has actually entered the run (active set).
    while (daemon.getSnapshot().activePlan !== "0001") {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Now request a graceful /stop while the child is still in-flight.
    const stopPromise = daemon.stop();
    // Give the stop logic a chance to run its synchronous setup (state flip,
    // sleep abort, etc.) without resolving the in-flight invoke.
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.getSnapshot().state).toBe("stopping");
    expect(cancelCount).toBe(0);

    // Resolve the invocation naturally — graceful stop should now complete.
    resolveInvoke!({
      planId: "0001",
      exitCode: 0,
      signal: null,
      rateLimited: false,
      logPath: path.join(repo.logsDir, "0001-graceful.log"),
      reason: "",
      startedAt: "2026-04-22T00:00:00.000Z",
      finishedAt: "2026-04-22T00:00:05.000Z",
    });

    await tickPromise;
    await stopPromise;

    expect(cancelCount).toBe(0);
    // The plan ran to completion — it migrated to completed/.
    expect(
      existsSync(path.join(repo.completedDir, "0001-fixture-plan.md")),
    ).toBe(true);
  });

  it("refuses to start when plan-graph validation fails", async () => {
    const repo = scaffoldRepo();
    // Plan references a missing dep; validateGraph should flag it.
    writePlan(repo.activeDir, "0001", { dependsOn: ["9999"] });
    await expect(
      createDaemon({
        repoRoot: repo.repoRoot,
        activeDir: repo.activeDir,
        completedDir: repo.completedDir,
        stateDir: repo.stateDir,
        logsDir: repo.logsDir,
        port: 0,
        logger: createSilentLogger(),
        mergeDetector: stubMergeDetector(),
        runInvoker: stubInvoker([], []),
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow(/plan graph is invalid/);
  });

  it("unblocks a blocked plan via the control API", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 1,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-fail.log"),
          reason: "forced failure",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
      ],
      invokeCalls,
    );
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();
    expect(daemon.getSnapshot().blocked["0001"]).toBeDefined();
    const res = daemon.unblock("0001");
    expect(res.ok).toBe(true);
    expect(daemon.getSnapshot().blocked["0001"]).toBeUndefined();
  });

  it("freeze writes a sentinel file, pauses, and blocks the tick from firing a plan", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const invokeCalls: FakeInvokeCall[] = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: stubInvoker([], invokeCalls),
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.freeze("rate-limit scare");
    expect(existsSync(path.join(repo.stateDir, "FROZEN"))).toBe(true);
    expect(daemon.getSnapshot().frozen).toBe(true);
    expect(daemon.getSnapshot().freezeReason).toBe("rate-limit scare");

    // Try to resume while frozen; tick sees FROZEN and keeps us paused.
    daemon.resume();
    await daemon.tickOnce();
    expect(invokeCalls).toHaveLength(0);
    expect(daemon.getSnapshot().state).toBe("paused");

    // Unfreeze removes the file; snapshot reflects it immediately.
    daemon.unfreeze();
    expect(existsSync(path.join(repo.stateDir, "FROZEN"))).toBe(false);
    expect(daemon.getSnapshot().frozen).toBe(false);
  });

  it("budget ceiling logs a warning but does not pause the daemon (CLI-auth mode)", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    writePlan(repo.activeDir, "0002", { dependsOn: ["0001"] });

    // Seed tokens-used.json for plan 0001 so aggregation pushes past a
    // deliberately tiny ceiling (500 tokens) on plan 0001's success path.
    const runDir = path.join(repo.repoRoot, ".task-runs/0001/20260422-000000");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "tokens-used.json"),
      JSON.stringify({
        phase: "implement",
        model: "claude-opus",
        inputTokens: 600,
        outputTokens: 400,
        costCents: 0,
      }) + "\n",
      "utf8",
    );

    const invokeCalls: FakeInvokeCall[] = [];
    const invoker = stubInvoker(
      [
        {
          planId: "0001",
          exitCode: 0,
          signal: null,
          rateLimited: false,
          logPath: path.join(repo.logsDir, "0001-done.log"),
          reason: "",
          startedAt: "2026-04-22T00:00:00.000Z",
          finishedAt: "2026-04-22T00:00:05.000Z",
        },
      ],
      invokeCalls,
    );
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      taskRunsDir: path.join(repo.repoRoot, ".task-runs"),
      tokenCeiling: 500,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: invoker,
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();

    // Plan 0001 ran and completed, aggregated 1000 tokens > 500 ceiling.
    expect(invokeCalls).toHaveLength(1);
    const snap = daemon.getSnapshot();
    expect(snap.budget.tokensUsed).toBe(1000);
    expect(snap.budget.ceilingReached).toBe(true);

    // Next tick must log the ceiling event for observability, but
    // continue running. CLI-auth workflows don't tie token count to
    // marginal cost — budget is advisory, not a blocker. Use /freeze
    // explicitly to pause on runaway spend.
    daemon.resume();
    await daemon.tickOnce();
    expect(daemon.getSnapshot().state).not.toBe("paused");
    expect(
      daemon
        .getSnapshot()
        .history.some((h) => h.event === "budget_ceiling_reached"),
    ).toBe(true);
  });

  it("fires the fidelity hook every N observed merges; passing report does not pause", async () => {
    const repo = scaffoldRepo();
    const hookCalls: Array<{ mergesSinceLast: number; total: number }> = [];
    // Scripted merge detector: two merges on the first poll, one on the
    // second. With fidelityCheckEveryNPlans=2 the hook fires after the
    // first poll.
    let polls = 0;
    const mergeDetector: MergeDetector = {
      async poll(lastMergeSha) {
        polls += 1;
        const merges =
          polls === 1
            ? [
                {
                  pr: {
                    number: 11,
                    title: "PR 11",
                    headRefName: "task/0011",
                    mergeCommit: "sha11",
                    mergedAt: "2026-04-22T00:00:00Z",
                  },
                  firstSeenAt: "2026-04-22T00:00:00Z",
                },
                {
                  pr: {
                    number: 12,
                    title: "PR 12",
                    headRefName: "task/0012",
                    mergeCommit: "sha12",
                    mergedAt: "2026-04-22T00:00:05Z",
                  },
                  firstSeenAt: "2026-04-22T00:00:05Z",
                },
              ]
            : polls === 2
              ? []
              : [];
        const latest =
          merges[merges.length - 1]?.pr.mergeCommit ?? lastMergeSha;
        return { merges, latestSha: latest };
      },
    };
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector,
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
      fidelityCheckEveryNPlans: 2,
      fidelityHook: async (ctx) => {
        hookCalls.push({
          mergesSinceLast: ctx.mergesSinceLast,
          total: ctx.totalMerges,
        });
        return { ok: true, score: 10, threshold: 25 };
      },
    });
    await daemon.start();
    // Resume so the daemon is actively running before the tick. Without
    // resume() the daemon starts paused and the assertion below would
    // pass whether the hook ran or not — see fidelity_blocked branch in
    // daemon.ts for the only path that flips mode → "paused".
    daemon.resume();
    await daemon.tickOnce();
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.mergesSinceLast).toBe(2);
    expect(daemon.getSnapshot().state).toBe("idle");
    expect(
      daemon.getSnapshot().history.some((h) => h.event === "fidelity_check_ok"),
    ).toBe(true);
  });

  it("pauses the daemon and logs fidelity_blocked when the hook reports a failing report", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const mergeDetector: MergeDetector = {
      async poll() {
        return {
          merges: [
            {
              pr: {
                number: 21,
                title: "PR 21",
                headRefName: "task/0021",
                mergeCommit: "sha21",
                mergedAt: "2026-04-22T00:00:00Z",
              },
              firstSeenAt: "2026-04-22T00:00:00Z",
            },
            {
              pr: {
                number: 22,
                title: "PR 22",
                headRefName: "task/0022",
                mergeCommit: "sha22",
                mergedAt: "2026-04-22T00:00:05Z",
              },
              firstSeenAt: "2026-04-22T00:00:05Z",
            },
          ],
          latestSha: "sha22",
        };
      },
    };
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector,
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
      fidelityCheckEveryNPlans: 2,
      fidelityHook: async () => ({
        ok: false,
        reason: "score 40 exceeds threshold 25",
        score: 40,
        threshold: 25,
      }),
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();
    expect(daemon.getSnapshot().state).toBe("paused");
    const history = daemon.getSnapshot().history;
    expect(history.some((h) => h.event === "fidelity_blocked")).toBe(true);
  });

  it("never dispatches 9999-prefixed auto-generated meta-plans, even when they are the only eligible id", async () => {
    // The 0053 fidelity flow drops an auto-created 9999-fidelity-review.md
    // into active/ and blocks every other plan. If the operator resumes the
    // daemon before deleting the meta-plan, the `pickNextEligiblePlan` guard
    // is the only thing preventing the daemon from executing the review
    // meta-plan as if it were a build task.
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "9999");
    writePlan(repo.activeDir, "0001");
    // Seed state so 0001 is in the blocked map — mirrors the state the
    // fidelity suspender produces when it blocks every active plan.
    writeFileSync(
      path.join(repo.stateDir, "state.json"),
      JSON.stringify({
        version: 1,
        mode: "paused",
        lastMergeSha: null,
        active: null,
        blocked: {
          "0001": {
            reason: "fidelity review gate",
            blockedAt: "2026-04-22T00:00:00.000Z",
            retries: 0,
          },
        },
        history: [],
        runsFired: 0,
      }),
      "utf8",
    );
    const invokeCalls: FakeInvokeCall[] = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector: stubMergeDetector(),
      runInvoker: stubInvoker([], invokeCalls),
      registerSignalHandlers: false,
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();

    expect(invokeCalls).toHaveLength(0);
    expect(daemon.getSnapshot().state).toBe("idle");
    expect(daemon.getSnapshot().activePlan).toBeNull();
  });

  it("writes RELEASE_READY and pauses when the release-gate hook passes (plan 0054)", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const mergeDetector: MergeDetector = {
      async poll() {
        return {
          merges: [
            {
              pr: {
                number: 99,
                title: "PR 99",
                headRefName: "task/0099",
                mergeCommit: "sha99",
                mergedAt: "2026-04-22T00:00:00Z",
              },
              firstSeenAt: "2026-04-22T00:00:00Z",
            },
          ],
          latestSha: "sha99",
        };
      },
    };
    const hookCalls: Array<{ mergesSinceLast: number }> = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector,
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
      releaseGateHook: async (ctx) => {
        hookCalls.push({ mergesSinceLast: ctx.mergesSinceLast });
        return {
          passed: true,
          specPath: "docs/product-specs/EXAMPLE.acceptance.md",
          reportPath: ".orchestrator/release-reports/2026-04-22-example.md",
        };
      },
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();
    expect(hookCalls).toHaveLength(1);
    expect(existsSync(path.join(repo.stateDir, "RELEASE_READY"))).toBe(true);
    const payload = JSON.parse(
      readFileSync(path.join(repo.stateDir, "RELEASE_READY"), "utf8"),
    );
    expect(payload.specPath).toBe("docs/product-specs/EXAMPLE.acceptance.md");
    expect(daemon.getSnapshot().state).toBe("paused");
    expect(
      daemon
        .getSnapshot()
        .history.some((h) => h.event === "release_candidate_ready"),
    ).toBe(true);
  });

  it("stays silent and runs nothing when the release-gate hook fails (plan 0054)", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    const mergeDetector: MergeDetector = {
      async poll() {
        return {
          merges: [
            {
              pr: {
                number: 1,
                title: "PR 1",
                headRefName: "task/0001",
                mergeCommit: "sha1",
                mergedAt: "2026-04-22T00:00:00Z",
              },
              firstSeenAt: "2026-04-22T00:00:00Z",
            },
          ],
          latestSha: "sha1",
        };
      },
    };
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector,
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
      releaseGateHook: async () => ({
        passed: false,
        reason: "uncovered tags",
      }),
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();
    expect(existsSync(path.join(repo.stateDir, "RELEASE_READY"))).toBe(false);
    // Silent on failure — no history entry, daemon keeps ticking normally.
    expect(
      daemon
        .getSnapshot()
        .history.some((h) => h.event === "release_candidate_ready"),
    ).toBe(false);
  });

  it("skips the release-gate hook when RELEASE_READY already exists (idempotent)", async () => {
    const repo = scaffoldRepo();
    writePlan(repo.activeDir, "0001");
    writeFileSync(
      path.join(repo.stateDir, "RELEASE_READY"),
      JSON.stringify({ at: "2026-04-22T00:00:00.000Z" }),
      "utf8",
    );
    const mergeDetector: MergeDetector = {
      async poll() {
        return {
          merges: [
            {
              pr: {
                number: 2,
                title: "PR 2",
                headRefName: "task/0002",
                mergeCommit: "sha2",
                mergedAt: "2026-04-22T00:00:00Z",
              },
              firstSeenAt: "2026-04-22T00:00:00Z",
            },
          ],
          latestSha: "sha2",
        };
      },
    };
    const hookCalls: Array<{ mergesSinceLast: number }> = [];
    daemon = await createDaemon({
      repoRoot: repo.repoRoot,
      activeDir: repo.activeDir,
      completedDir: repo.completedDir,
      stateDir: repo.stateDir,
      logsDir: repo.logsDir,
      port: 0,
      logger: createSilentLogger(),
      mergeDetector,
      runInvoker: stubInvoker([], []),
      registerSignalHandlers: false,
      releaseGateHook: async (ctx) => {
        hookCalls.push({ mergesSinceLast: ctx.mergesSinceLast });
        return { passed: true };
      },
    });
    await daemon.start();
    daemon.resume();
    await daemon.tickOnce();
    expect(hookCalls).toHaveLength(0);
  });
});
