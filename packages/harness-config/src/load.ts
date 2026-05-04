// Loads `harness.config.{json,ts}` from a target repo's root. Order:
//   1. harness.config.ts  — imported via the runtime's TS support
//      (works under `node --experimental-strip-types` and `tsx`)
//   2. harness.config.json — JSON.parse
// First match wins. After loading, env-var overrides are applied
// (HARNESS_AGENT_PROVIDER, HARNESS_AGENT_MODEL, HARNESS_BASE_BRANCH, etc.),
// then the result is validated against the Zod schema.
//
// Repo-agnostic by design: the loader takes a repoRoot, reads only files
// under it, and never inspects this harness's own filesystem.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  HarnessConfigSchema,
  type HarnessConfig,
  type HarnessConfigInput,
} from "./schema.ts";

export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConfigError";
  }
}

const CONFIG_BASENAMES = [
  "harness.config.ts",
  "harness.config.mts",
  "harness.config.js",
  "harness.config.mjs",
  "harness.config.json",
] as const;

export interface LoadHarnessConfigOptions {
  // Test seam — defaults to process.env.
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadHarnessConfig(
  repoRoot: string,
  options: LoadHarnessConfigOptions = {},
): Promise<HarnessConfig> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  const found = findConfigFile(repoRoot);
  let raw: unknown;
  if (!found) {
    // No file on disk is fine as long as env vars or defaults can satisfy
    // the schema (i.e., HARNESS_AGENT_PROVIDER is set). If validation
    // fails below the error will name the missing fields.
    raw = {};
  } else if (found.endsWith(".json")) {
    const text = readFileSync(found, "utf8");
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new HarnessConfigError(
        `failed to parse ${path.relative(repoRoot, found)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    raw = await importConfigModule(found);
  }

  const merged = applyEnvOverrides(raw as HarnessConfigInput, env);
  const result = HarnessConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new HarnessConfigError(
      `harness config is invalid:\n${issues}\n\nLooked at: ${
        found ? path.relative(repoRoot, found) : "(no config file)"
      }. Set HARNESS_AGENT_PROVIDER or write a harness.config.{json,ts}.`,
    );
  }
  return result.data;
}

function findConfigFile(repoRoot: string): string | null {
  for (const basename of CONFIG_BASENAMES) {
    const candidate = path.join(repoRoot, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function importConfigModule(filePath: string): Promise<unknown> {
  // Dynamic import handles .ts/.mts/.js/.mjs uniformly. The runtime needs
  // either built-in TS stripping (Node >=22 with --experimental-strip-types)
  // or `tsx` to be on NODE_OPTIONS for the .ts variant; we don't try to
  // double-shim that here.
  let mod: { default?: unknown } & Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(filePath).href)) as typeof mod;
  } catch (err) {
    throw new HarnessConfigError(
      `failed to import ${path.basename(filePath)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const exported = mod.default ?? mod.config ?? mod.harness ?? null;
  if (exported === null) {
    throw new HarnessConfigError(
      `${path.basename(
        filePath,
      )} must export a config object as its default export`,
    );
  }
  return typeof exported === "function"
    ? await (exported as () => unknown | Promise<unknown>)()
    : exported;
}

function applyEnvOverrides(
  raw: HarnessConfigInput | Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): HarnessConfigInput {
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  setIf(out, "planDir", env.HARNESS_PLAN_DIR);
  setIf(out, "completedDir", env.HARNESS_COMPLETED_DIR);
  setIf(out, "contextDir", env.HARNESS_CONTEXT_DIR);
  setIf(out, "stateDir", env.HARNESS_STATE_DIR);
  setIf(out, "baseBranch", env.HARNESS_BASE_BRANCH);

  const agent = (out.agent as Record<string, unknown> | undefined) ?? {};
  setIf(agent, "provider", env.HARNESS_AGENT_PROVIDER);
  setIf(agent, "model", env.HARNESS_AGENT_MODEL);
  if (env.HARNESS_AGENT_MAX_REVIEW_PASSES) {
    agent.maxReviewPasses = Number(env.HARNESS_AGENT_MAX_REVIEW_PASSES);
  }
  if (Object.keys(agent).length > 0) out.agent = agent;

  const modelClient =
    (out.modelClient as Record<string, unknown> | undefined) ?? {};
  setIf(modelClient, "provider", env.HARNESS_MODEL_CLIENT_PROVIDER);
  setIf(modelClient, "model", env.HARNESS_MODEL_CLIENT_MODEL);
  if (Object.keys(modelClient).length > 0) out.modelClient = modelClient;

  if (env.BUDGET_CEILING_TOKENS) {
    const budget =
      (out.budget as Record<string, unknown> | undefined) ?? {};
    budget.ceilingTokens = Number(env.BUDGET_CEILING_TOKENS);
    out.budget = budget;
  }

  return out as HarnessConfigInput;
}

function setIf(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") target[key] = value;
}

// Convenience: discover the target repo from the CLI/env. `--repo <path>`
// is checked by the CLI binary and forwarded; this helper just resolves
// the env-var fallback and process.cwd().
export function resolveRepoRoot(
  env: Readonly<Record<string, string | undefined>> = process.env as Record<
    string,
    string | undefined
  >,
): string {
  const fromEnv = env.HARNESS_TARGET_REPO;
  if (fromEnv && fromEnv !== "") return path.resolve(fromEnv);
  return process.cwd();
}
