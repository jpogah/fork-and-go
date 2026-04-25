// Token-to-cost rate card. Mirrors the per-million-token prices the model
// client uses (packages/model-client/src/model-client.ts) so the single source
// of truth is numeric, not code-location. When model pricing changes, update
// this table too.
//
// Numbers are US cents per million tokens. Anything that hits the runner is
// Claude today; OpenAI entries cover planner/fidelity work that also rolls
// through the harness budget.

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelRate {
  readonly model: string;
  readonly inputCentsPerMTok: number;
  readonly outputCentsPerMTok: number;
}

// Each entry is matched case-insensitively with `String.includes`. The first
// matching entry wins, so order from most-specific to most-generic.
export const RATE_CARD: readonly ModelRate[] = [
  // Anthropic Claude (runner)
  {
    model: "claude-opus",
    inputCentsPerMTok: 1500,
    outputCentsPerMTok: 7500,
  },
  {
    model: "claude-sonnet",
    inputCentsPerMTok: 300,
    outputCentsPerMTok: 1500,
  },
  {
    model: "claude-haiku",
    inputCentsPerMTok: 80,
    outputCentsPerMTok: 400,
  },
  // OpenAI GPT-5.4 (planner / fidelity) — matches packages/model-client/src/model-client.ts
  {
    model: "gpt-5.4-mini",
    inputCentsPerMTok: 25,
    outputCentsPerMTok: 200,
  },
  {
    model: "gpt-5.4",
    inputCentsPerMTok: 250,
    outputCentsPerMTok: 2000,
  },
] as const;

// Fallback applied when the model string doesn't match any rate card entry.
// Chosen to be conservative (biased high) so budget math never *under*-charges
// an unknown model — operators who see a $0 estimate would not realize there
// was a tracking miss.
export const FALLBACK_RATE: ModelRate = {
  model: "unknown",
  inputCentsPerMTok: 500,
  outputCentsPerMTok: 2500,
};

export function rateFor(model: string): ModelRate {
  const needle = model.toLowerCase();
  for (const rate of RATE_CARD) {
    if (needle.includes(rate.model.toLowerCase())) return rate;
  }
  return FALLBACK_RATE;
}

export function estimateCostCents(model: string, usage: TokenUsage): number {
  const rate = rateFor(model);
  const inputCost = (usage.inputTokens / 1_000_000) * rate.inputCentsPerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * rate.outputCentsPerMTok;
  return Math.round((inputCost + outputCost) * 100) / 100;
}
