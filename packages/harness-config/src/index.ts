// @harness/config — repo-agnostic config loader for the harness.
//
// Target repos commit a `harness.config.{json,ts}` at their root. The
// orchestrator + CLI call `loadHarnessConfig(repoRoot)` to get a typed,
// validated config. Env vars (`HARNESS_*`) override file fields.

export {
  HarnessConfigSchema,
  type HarnessConfig,
  type HarnessConfigInput,
} from "./schema.ts";

export {
  HarnessConfigError,
  loadHarnessConfig,
  resolveRepoRoot,
  type LoadHarnessConfigOptions,
} from "./load.ts";

export { resolvePaths, type ResolvedPaths } from "./paths.ts";

export {
  composeSecretsProviders,
  createEnvSecretsProvider,
  createMemorySecretsProvider,
  type SecretName,
  type SecretsProvider,
} from "./secrets.ts";
