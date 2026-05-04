// Resolved-path helpers. All path fields in HarnessConfig are stored as
// repo-relative strings; consumers call these helpers to get absolute
// paths anchored at the target repo's root. Keeping this in one place
// means every consumer treats paths the same way.

import path from "node:path";

import type { HarnessConfig } from "./schema.ts";

export interface ResolvedPaths {
  repoRoot: string;
  planDir: string;
  completedDir: string;
  contextDir: string | null;
  stateDir: string;
  logsDir: string;
  taskRunsDir: string;
  appPaths: string[];
  fidelitySpec: string | null;
  releaseGateSpec: string | null;
}

export function resolvePaths(
  repoRoot: string,
  config: HarnessConfig,
): ResolvedPaths {
  const stateDir = absolute(repoRoot, config.stateDir);
  return {
    repoRoot,
    planDir: absolute(repoRoot, config.planDir),
    completedDir: absolute(repoRoot, config.completedDir),
    contextDir: config.contextDir ? absolute(repoRoot, config.contextDir) : null,
    stateDir,
    logsDir: path.join(stateDir, "logs"),
    taskRunsDir: path.join(stateDir, "task-runs"),
    appPaths: config.appPaths.map((p) => absolute(repoRoot, p)),
    fidelitySpec: config.fidelity?.specPath
      ? absolute(repoRoot, config.fidelity.specPath)
      : null,
    releaseGateSpec: config.releaseGate?.specPath
      ? absolute(repoRoot, config.releaseGate.specPath)
      : null,
  };
}

function absolute(repoRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}
