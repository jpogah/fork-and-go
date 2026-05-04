// Daemon bootstrap helper used by the harness CLI. Wires HarnessConfig
// + repo root into createDaemon and starts it. Lives separately from
// index.ts because index.ts also exports types and the CLI needs a
// callable boot function.

import { existsSync } from "node:fs";
import path from "node:path";

import type { HarnessConfig } from "@harness/config";
import { createAgentRunner, wrapAgentAsCompletionClient } from "@harness/agent-runner";
import { runFidelityCheck } from "@harness/fidelity-check";
import { runReleaseGate } from "@harness/release-gate";

import {
  createDaemon,
  type FidelityHook,
  type ReleaseGateHook,
} from "./daemon.ts";

export interface BootstrapOptions {
  repoRoot: string;
  config: HarnessConfig;
  port?: number;
}

export default async function startDaemon(
  opts: BootstrapOptions,
): Promise<void> {
  const port = opts.port ?? 4500;
  const fidelityOpts: {
    fidelityCheckEveryNPlans?: number;
    fidelityHook?: FidelityHook;
  } = {};
  if (opts.config.fidelity?.specPath && (opts.config.fidelity.everyNPlans ?? 0) > 0) {
    const specAbs = path.isAbsolute(opts.config.fidelity.specPath)
      ? opts.config.fidelity.specPath
      : path.resolve(opts.repoRoot, opts.config.fidelity.specPath);
    if (existsSync(specAbs)) {
      fidelityOpts.fidelityCheckEveryNPlans = opts.config.fidelity.everyNPlans!;
      fidelityOpts.fidelityHook = buildFidelityHook(opts.repoRoot, specAbs, opts.config);
    }
  }
  const releaseOpts: { releaseGateHook?: ReleaseGateHook } = {};
  if (opts.config.releaseGate?.specPath) {
    const specAbs = path.isAbsolute(opts.config.releaseGate.specPath)
      ? opts.config.releaseGate.specPath
      : path.resolve(opts.repoRoot, opts.config.releaseGate.specPath);
    if (existsSync(specAbs)) {
      releaseOpts.releaseGateHook = buildReleaseGateHook(
        opts.repoRoot,
        specAbs,
        opts.config,
      );
    }
  }

  const daemon = await createDaemon({
    repoRoot: opts.repoRoot,
    config: opts.config,
    port,
    ...(opts.config.budget.ceilingTokens
      ? { tokenCeiling: opts.config.budget.ceilingTokens }
      : {}),
    ...fidelityOpts,
    ...releaseOpts,
  });
  const addr = await daemon.start();
  process.stdout.write(
    JSON.stringify({
      event: "orchestrator_started",
      host: addr.host,
      port: addr.port,
      repoRoot: opts.repoRoot,
    }) + "\n",
  );
}

function buildFidelityHook(
  repoRoot: string,
  specPath: string,
  config: HarnessConfig,
): FidelityHook {
  return async () => {
    try {
      const runner = createAgentRunner({
        provider: config.modelClient.provider ?? config.agent.provider,
        ...(config.modelClient.model
          ? { model: config.modelClient.model }
          : config.agent.model
            ? { model: config.agent.model }
            : {}),
      });
      const modelClient = wrapAgentAsCompletionClient(runner, { cwd: repoRoot });
      const reportsDir = path.join(
        repoRoot,
        config.stateDir,
        "fidelity-reports",
      );
      const outcome = await runFidelityCheck(
        {
          specPath,
          activeDir: path.join(repoRoot, config.planDir),
          completedDir: path.join(repoRoot, config.completedDir),
          reportsDir,
          repoRoot,
          appPaths: config.appPaths,
        },
        { modelClient },
      );
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return {
        ok: !outcome.exceedsThreshold,
        score: outcome.score,
        threshold: outcome.threshold,
        reportPath: outcome.report.markdownPath,
      };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

function buildReleaseGateHook(
  repoRoot: string,
  specPath: string,
  config: HarnessConfig,
): ReleaseGateHook {
  return async () => {
    try {
      const reportsDir = path.join(
        repoRoot,
        config.stateDir,
        "release-reports",
      );
      const result = await runReleaseGate({
        specPath,
        activeDir: path.join(repoRoot, config.planDir),
        completedDir: path.join(repoRoot, config.completedDir),
        envTemplatePath: path.join(repoRoot, ".env.example"),
        reportsDir,
        repoRoot,
        writeReport: false,
        runTests: false,
      });
      if (!result.ok) return { passed: false, reason: result.reason, specPath };
      const passed = result.report.passed;
      const unmet = result.report.criteria.filter(
        (c) => c.status !== "covered",
      ).length;
      return {
        passed,
        specPath,
        ...(passed ? {} : { reason: `${unmet} criteria not covered` }),
      };
    } catch (err) {
      return {
        passed: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
