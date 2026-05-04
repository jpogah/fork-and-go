// Orchestrator daemon entry point. Boots the daemon against a target
// repo identified by --repo, HARNESS_TARGET_REPO env var, or the current
// working directory (in that precedence order). Loads the target's
// harness.config.{json,ts} via @harness/config, builds a HarnessConfig,
// and starts the long-running watcher. The runner is in-process now —
// no scripts/run_task.sh subprocess.

import { existsSync } from "node:fs";
import path from "node:path";

import { loadHarnessConfig, resolveRepoRoot } from "@harness/config";
import { runFidelityCheck } from "@harness/fidelity-check";
import { runReleaseGate } from "@harness/release-gate";
import { createAgentRunner, wrapAgentAsCompletionClient } from "@harness/agent-runner";

import {
  createDaemon,
  type FidelityHook,
  type ReleaseGateHook,
} from "./daemon.ts";

export const DEFAULT_PORT = 4500;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = parseRepoFlag(argv) ?? resolveRepoRoot(process.env);
  if (!existsSync(repoRoot)) {
    throw new Error(`target repo not found: ${repoRoot}`);
  }

  const config = await loadHarnessConfig(repoRoot, { env: process.env });
  const port = parsePort(process.env.ORCHESTRATOR_PORT) ?? DEFAULT_PORT;
  const tokenCeiling =
    parseCeiling(process.env.BUDGET_CEILING_TOKENS) ??
    config.budget.ceilingTokens ??
    null;

  const fidelityOpts: {
    fidelityCheckEveryNPlans?: number;
    fidelityHook?: FidelityHook;
  } = {};
  if (config.fidelity?.specPath && (config.fidelity.everyNPlans ?? 0) > 0) {
    const specAbs = path.isAbsolute(config.fidelity.specPath)
      ? config.fidelity.specPath
      : path.resolve(repoRoot, config.fidelity.specPath);
    if (!existsSync(specAbs)) {
      throw new Error(
        `harness.config.fidelity.specPath points at ${config.fidelity.specPath} but that file does not exist (resolved to ${specAbs}).`,
      );
    }
    fidelityOpts.fidelityCheckEveryNPlans = config.fidelity.everyNPlans!;
    fidelityOpts.fidelityHook = createFidelityHook({
      repoRoot,
      specPath: specAbs,
      config,
    });
  }

  const releaseOpts: { releaseGateHook?: ReleaseGateHook } = {};
  if (config.releaseGate?.specPath) {
    const specAbs = path.isAbsolute(config.releaseGate.specPath)
      ? config.releaseGate.specPath
      : path.resolve(repoRoot, config.releaseGate.specPath);
    if (existsSync(specAbs)) {
      releaseOpts.releaseGateHook = createReleaseGateHook({
        repoRoot,
        specPath: specAbs,
        config,
      });
    }
  }

  const daemon = await createDaemon({
    repoRoot,
    config,
    port,
    ...(tokenCeiling !== null ? { tokenCeiling } : {}),
    ...fidelityOpts,
    ...releaseOpts,
  });
  const addr = await daemon.start();
  process.stdout.write(
    JSON.stringify({
      event: "orchestrator_started",
      host: addr.host,
      port: addr.port,
      repoRoot,
    }) + "\n",
  );
}

function parseRepoFlag(argv: ReadonlyArray<string>): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (!value) throw new Error("--repo requires a path argument");
      return path.resolve(value);
    }
    if (arg.startsWith("--repo=")) {
      return path.resolve(arg.slice("--repo=".length));
    }
  }
  return null;
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(
      `ORCHESTRATOR_PORT must be a port in 1..65535, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseCeiling(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `BUDGET_CEILING_TOKENS must be a positive number, got ${JSON.stringify(value)}`,
    );
  }
  return Math.floor(parsed);
}

// Direct in-process fidelity hook. Replaces the previous bash shellout to
// `./scripts/check-fidelity.sh`. Builds an AgentRunner from config,
// wraps it as a CompletionClient, and calls runFidelityCheck() in-proc.
function createFidelityHook(opts: {
  repoRoot: string;
  specPath: string;
  config: import("@harness/config").HarnessConfig;
}): FidelityHook {
  return async () => {
    try {
      const runner = createAgentRunner({
        provider:
          opts.config.modelClient.provider ?? opts.config.agent.provider,
        ...(opts.config.modelClient.model
          ? { model: opts.config.modelClient.model }
          : opts.config.agent.model
            ? { model: opts.config.agent.model }
            : {}),
      });
      const modelClient = wrapAgentAsCompletionClient(runner, {
        cwd: opts.repoRoot,
      });
      const reportsDir = path.join(
        opts.repoRoot,
        opts.config.stateDir,
        "fidelity-reports",
      );
      const outcome = await runFidelityCheck(
        {
          specPath: opts.specPath,
          activeDir: path.join(opts.repoRoot, opts.config.planDir),
          completedDir: path.join(opts.repoRoot, opts.config.completedDir),
          reportsDir,
          repoRoot: opts.repoRoot,
          appPaths: opts.config.appPaths,
        },
        { modelClient },
      );
      if (!outcome.ok) {
        return { ok: false, reason: outcome.reason };
      }
      return {
        ok: !outcome.exceedsThreshold,
        score: outcome.score,
        threshold: outcome.threshold,
        reportPath: outcome.report.markdownPath,
      };
    } catch (err) {
      return {
        ok: false,
        reason:
          err instanceof Error
            ? `fidelity hook error: ${err.message}`
            : `fidelity hook error: ${String(err)}`,
      };
    }
  };
}

function createReleaseGateHook(opts: {
  repoRoot: string;
  specPath: string;
  config: import("@harness/config").HarnessConfig;
}): ReleaseGateHook {
  return async () => {
    try {
      const reportsDir = path.join(
        opts.repoRoot,
        opts.config.stateDir,
        "release-reports",
      );
      const envTemplatePath = path.join(opts.repoRoot, ".env.example");
      const result = await runReleaseGate({
        specPath: opts.specPath,
        activeDir: path.join(opts.repoRoot, opts.config.planDir),
        completedDir: path.join(opts.repoRoot, opts.config.completedDir),
        envTemplatePath,
        reportsDir,
        repoRoot: opts.repoRoot,
        writeReport: false,
        runTests: false,
      });
      if (!result.ok) {
        return { passed: false, reason: result.reason, specPath: opts.specPath };
      }
      const passed = result.report.passed;
      const unmet = result.report.criteria.filter(
        (c) => c.status !== "covered",
      ).length;
      return {
        passed,
        specPath: opts.specPath,
        ...(passed ? {} : { reason: `${unmet} criteria not covered` }),
      };
    } catch (err) {
      return {
        passed: false,
        reason:
          err instanceof Error
            ? `release gate error: ${err.message}`
            : `release gate error: ${String(err)}`,
      };
    }
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(
      `orchestrator: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
