// Pluggable secrets provider for the harness.
//
// The OSS default reads from `process.env`. The cloud passes a vault-
// backed provider that decrypts per-project sealed boxes from Postgres
// and exposes them only to the agent SDK call. Either way, the rest of
// the harness reads secrets through this interface — no `process.env`
// reads in agent-runner, no SDK key in plaintext outside the runner.
//
// Names are normalized so an alias-aware provider can serve a request
// for `ANTHROPIC_API_KEY` from `claude.api_key` (or whatever the cloud
// chose to call it) without touching the consumer.

export type SecretName =
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY"
  | "GH_TOKEN"
  // Any other key the consumer might ask for. The interface accepts
  // arbitrary strings so consumers don't have to upgrade the union to
  // request a new one.
  | (string & {});

export interface SecretsProvider {
  // Returns the secret value, or undefined if not set. Implementations
  // must never throw on a missing secret — callers branch on undefined.
  get(name: SecretName): string | undefined | Promise<string | undefined>;
}

// Default OSS provider — reads from process.env. Used by the runner
// today; the cloud overrides with a vault-backed provider per request.
export function createEnvSecretsProvider(
  env: Readonly<Record<string, string | undefined>> = process.env as Record<
    string,
    string | undefined
  >,
): SecretsProvider {
  return {
    get(name) {
      return env[name];
    },
  };
}

// In-memory provider — useful for tests and worked example for
// implementers writing a vault-backed adapter.
export function createMemorySecretsProvider(
  values: Readonly<Record<string, string>>,
): SecretsProvider {
  return {
    get(name) {
      return values[name];
    },
  };
}

// Composes providers: tries each in order, returns the first hit. Useful
// when the cloud wants its vault to take precedence with env as a
// fallback for non-secret config.
export function composeSecretsProviders(
  ...providers: SecretsProvider[]
): SecretsProvider {
  return {
    async get(name) {
      for (const p of providers) {
        const v = await Promise.resolve(p.get(name));
        if (v !== undefined) return v;
      }
      return undefined;
    },
  };
}
