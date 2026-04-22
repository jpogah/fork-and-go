// Orchestrator daemon entry point. Boots the daemon, wires in defaults from
// the environment, and awaits shutdown. Designed to be launched via
// `scripts/orchestrator.sh` in production and via `node --experimental-
// strip-types src/index.ts` in development.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDaemon,
  type FidelityHook,
  type ReleaseGateHook,
} from "./daemon.ts";

export const DEFAULT_PORT = 4500;
export const DEFAULT_FIDELITY_SPEC = "docs/product-specs/EXAMPLE.md";
export const DEFAULT_RELEASE_SPEC = "docs/product-specs/EXAMPLE.acceptance.md";

async function main(): Promise<void> {
  const repoRoot = path.resolve(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const port = parsePort(process.env.ORCHESTRATOR_PORT) ?? DEFAULT_PORT;
  const tokenCeiling = parseCeiling(process.env.BUDGET_CEILING_TOKENS);
  const fidelityEveryN = parseFidelityEveryN(
    process.env.FIDELITY_CHECK_EVERY_N_PLANS,
  );
  const fidelitySpec = process.env.FIDELITY_CHECK_SPEC || DEFAULT_FIDELITY_SPEC;

  const fidelityOpts: {
    fidelityCheckEveryNPlans?: number;
    fidelityHook?: FidelityHook;
  } = {};
  if (fidelityEveryN > 0) {
    // Fail fast if the configured spec isn't on disk. Without this check the
    // daemon boots happily and every fidelity firing EISDIR/ENOENT-fails
    // silently through the checker — misconfiguration as an env-unset
    // install would never surface until the Nth merge.
    const specAbs = path.isAbsolute(fidelitySpec)
      ? fidelitySpec
      : path.resolve(repoRoot, fidelitySpec);
    if (!existsSync(specAbs)) {
      throw new Error(
        `FIDELITY_CHECK_SPEC points at ${fidelitySpec} but that file does not exist (resolved to ${specAbs}). Set FIDELITY_CHECK_EVERY_N_PLANS=0 to disable the hook, or point FIDELITY_CHECK_SPEC at a real product spec.`,
      );
    }
    fidelityOpts.fidelityCheckEveryNPlans = fidelityEveryN;
    fidelityOpts.fidelityHook = createScriptFidelityHook({
      repoRoot,
      specPath: fidelitySpec,
    });
  }

  // Plan 0054: release-gate hook. Enabled whenever RELEASE_GATE_SPEC points
  // at a real acceptance file. Silent on failure — "not ready" is the
  // normal case — so we don't need a separate enable/disable env var.
  const releaseSpec = process.env.RELEASE_GATE_SPEC || DEFAULT_RELEASE_SPEC;
  const releaseOpts: { releaseGateHook?: ReleaseGateHook } = {};
  const releaseSpecAbs = path.isAbsolute(releaseSpec)
    ? releaseSpec
    : path.resolve(repoRoot, releaseSpec);
  if (existsSync(releaseSpecAbs)) {
    releaseOpts.releaseGateHook = createScriptReleaseGateHook({
      repoRoot,
      specPath: releaseSpec,
    });
  }

  const daemon = await createDaemon({
    repoRoot,
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

  // Keep the process alive — daemon.stop() resolves the signal handlers'
  // await which lets the event loop drain naturally.
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

function parseFidelityEveryN(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `FIDELITY_CHECK_EVERY_N_PLANS must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

// Fidelity hook that shells out to `./scripts/check-fidelity.sh`. The
// script itself is responsible for writing the report and calling
// `plan-graph set-status` + the 9999 meta-plan when drift exceeds the
// threshold — this hook translates the exit code into
// `{ ok: true/false }` for the daemon and forwards the script's stdout
// so `drift score …` / `wrote …` lines land in the daemon log. The
// markdown report path and drift score are parsed back out so they can
// ride along on the `fidelity_check_ok` / `fidelity_blocked` history
// entry the daemon writes.
function createScriptFidelityHook(opts: {
  repoRoot: string;
  specPath: string;
}): FidelityHook {
  return async () => {
    return await new Promise((resolve) => {
      const child = spawn(
        path.join(opts.repoRoot, "scripts", "check-fidelity.sh"),
        ["--spec", opts.specPath],
        {
          cwd: opts.repoRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        process.stdout.write(text);
      });
      child.on("error", (err) => {
        resolve({ ok: false, reason: `checker spawn failed: ${err.message}` });
      });
      child.on("close", (code) => {
        const parsed = parseFidelityStdout(stdout);
        if (code === 0) {
          resolve({ ok: true, ...parsed });
          return;
        }
        resolve({
          ok: false,
          reason: stderr.trim() || `check-fidelity.sh exited with code ${code}`,
          ...parsed,
        });
      });
    });
  };
}

// Plan 0054: release-gate hook that shells out to `./scripts/release-gate.sh`.
// The script exits 0 when READY and non-zero otherwise. We run in dry-run
// mode (no report writes) on the orchestrator path — the CLI itself writes
// reports during operator-driven runs. Keeps the daemon from churning one
// report per merge.
function createScriptReleaseGateHook(opts: {
  repoRoot: string;
  specPath: string;
}): ReleaseGateHook {
  return async () => {
    return await new Promise((resolve) => {
      const child = spawn(
        path.join(opts.repoRoot, "scripts", "release-gate.sh"),
        ["--spec", opts.specPath, "--dry-run", "--quiet"],
        {
          cwd: opts.repoRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {
        // Swallow — release gate failure is the normal case and must stay
        // silent. Errors worth surfacing come through a non-zero exit; the
        // daemon's release_gate_hook_error branch handles those.
      });
      child.on("error", (err) => {
        resolve({
          passed: false,
          reason: `release-gate.sh spawn failed: ${err.message}`,
        });
      });
      child.on("close", (code) => {
        const passed = code === 0;
        resolve({
          passed,
          specPath: opts.specPath,
          ...(stdout.trim() ? { reason: stdout.trim() } : {}),
        });
      });
    });
  };
}

function parseFidelityStdout(stdout: string): {
  score?: number;
  threshold?: number;
  reportPath?: string;
} {
  const result: { score?: number; threshold?: number; reportPath?: string } =
    {};
  const scoreMatch = stdout.match(/drift score (\d+)\/100 \(threshold (\d+)\)/);
  if (scoreMatch) {
    result.score = Number(scoreMatch[1]);
    result.threshold = Number(scoreMatch[2]);
  }
  const wroteMatch = stdout.match(/^wrote (.+\.md)$/m);
  if (wroteMatch) {
    result.reportPath = wroteMatch[1]!;
  }
  return result;
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
