// Zod schema for harness.config.{json,ts}. The harness reads this from the
// target repo's root and uses it to drive every repo-specific decision —
// where plans live, which agent to drive, how to start the dev server,
// what `npm run e2e` actually maps to in this repo, and so on.
//
// Keep the schema flat and explicit. The harness has no opinion about how
// the target repo is laid out beyond the directories the schema names; if
// a target repo wants to keep plans somewhere unusual, that's the field
// they edit.

import { z } from "zod";

const NonEmpty = z
  .string()
  .min(1, { message: "must be a non-empty string" });

const AgentProvider = z.enum(["claude", "codex"]);
const ModelClientProvider = z.enum(["claude", "codex"]);

const AgentConfig = z.object({
  provider: AgentProvider,
  model: z.string().optional(),
  maxReviewPasses: z.number().int().positive().default(5),
  reasoningEffort: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .optional(),
});

// Planner / fidelity-check / site-reverse run as agents too — they use the
// same SDKs, just in `complete` mode (no tools). This sub-config lets the
// target repo drive those with a different provider/model than the main
// implementer agent if they want (e.g., implementer = claude, planner =
// codex). Defaults to whatever `agent.provider` is.
const ModelClientConfig = z.object({
  provider: ModelClientProvider.optional(),
  model: z.string().optional(),
});

const DevServerConfig = z.object({
  command: NonEmpty,
  url: NonEmpty.url({ message: "devServer.url must be a valid URL" }),
  readyTimeoutSec: z.number().int().positive().default(60),
});

const E2eConfig = z.object({
  command: NonEmpty,
  artifactDirs: z.array(NonEmpty).default([]),
});

const BudgetConfig = z.object({
  ceilingTokens: z.number().int().positive().optional(),
});

const ReleaseGateConfig = z.object({
  specPath: NonEmpty,
});

const FidelityConfig = z.object({
  specPath: NonEmpty,
  everyNPlans: z.number().int().nonnegative().default(0),
});

export const HarnessConfigSchema = z.object({
  // Where plans live in the target repo, relative to the repo root.
  planDir: NonEmpty.default("docs/exec-plans/active"),
  completedDir: NonEmpty.default("docs/exec-plans/completed"),

  // Optional context drop folder (planner reads from here).
  contextDir: NonEmpty.optional(),

  // Where the harness writes its own state (logs, budget, freeze flag).
  // Defaults to `.orchestrator/` at the target repo root.
  stateDir: NonEmpty.default(".orchestrator"),

  // Directories the fidelity-check agent should slice when assembling
  // context. Replaces the old hardcoded `apps/web/app` + `packages/`.
  appPaths: z.array(NonEmpty).default(["src"]),

  // The branch the runner compares + opens PRs against.
  baseBranch: NonEmpty.default("main"),

  agent: AgentConfig,
  modelClient: ModelClientConfig.default({}),

  devServer: DevServerConfig.optional(),
  e2e: E2eConfig.optional(),
  budget: BudgetConfig.default({}),
  releaseGate: ReleaseGateConfig.optional(),
  fidelity: FidelityConfig.optional(),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

// The shape consumers may pass in. Everything optional except `agent`.
export type HarnessConfigInput = z.input<typeof HarnessConfigSchema>;
