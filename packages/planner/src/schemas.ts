// Zod shapes shared across the planner. `planProposalSchema` is the contract
// with the decompose LLM: a strict shape that matches the 0048 frontmatter's
// fields plus a `summary` and `scope_bullets` used by the draft phase. We
// intentionally do *not* reuse `planFrontmatterSchema` directly — the LLM
// produces a proposal, not yet a plan file, and `status` / `acceptance_tags`
// are fixed by the planner on emit rather than chosen by the model.

import { z } from "zod";

const PLAN_ID_REGEX = /^\d{4}$/u;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u;

export const planProposalSchema = z
  .object({
    id: z
      .string()
      .regex(PLAN_ID_REGEX, "id must be a zero-padded 4-digit string"),
    slug: z
      .string()
      .regex(
        SLUG_REGEX,
        "slug must be kebab-case (lowercase letters, digits, hyphens)",
      )
      .min(3)
      .max(80),
    title: z.string().min(1),
    phase: z.string().min(1),
    depends_on: z.array(z.string().regex(PLAN_ID_REGEX)).default([]),
    estimated_passes: z.number().int().positive(),
    summary: z.string().min(1),
    scope_bullets: z.array(z.string().min(1)).min(1),
    // Plan 0054: optional acceptance tags the plan claims to cover. The
    // decompose LLM populates this from the acceptance file when the
    // planner has one; otherwise it stays absent and `composePlanFile`
    // writes `acceptance_tags: []` into the frontmatter. Intentionally
    // `.optional()` rather than `.default([])` so test fixtures that
    // hand-build proposals (pre-0054) continue to type-check without
    // touching every call site.
    acceptance_tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type PlanProposal = z.infer<typeof planProposalSchema>;

export const decomposeOutputSchema = z
  .object({
    proposals: z.array(planProposalSchema),
  })
  .strict();

export type DecomposeOutput = z.infer<typeof decomposeOutputSchema>;

// Shape returned to the operator or caller after a planner run.
export interface PlannerRunResult {
  proposals: PlanProposal[];
  emitted: Array<{ id: string; filePath: string }>;
  skipped: Array<{ id: string; reason: "completed" | "matches-active" }>;
  conflicts: Array<{ id: string; reason: string }>;
  mode: "preview" | "emit";
}
