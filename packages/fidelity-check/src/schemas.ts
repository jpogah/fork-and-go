// Zod shapes for the audit LLM's JSON output. The checker commits to a
// strict shape so a single pass of validation catches hallucination modes
// (missing sections, wrong enum values) before we try to score.

import { z } from "zod";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const COVERAGE_STATUSES = ["met", "partial", "unmet"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

const PLAN_ID_REGEX = /^\d{4}$/u;

export const requirementItemSchema = z
  .object({
    requirement: z.string().min(1),
    status: z.enum(COVERAGE_STATUSES),
    // Plan id that covers (or should cover) this requirement. May be empty
    // for unmet items where the auditor can't point at any plan.
    plan_id: z.string().regex(PLAN_ID_REGEX).optional(),
    notes: z.string().default(""),
  })
  .strict();

export type RequirementItem = z.infer<typeof requirementItemSchema>;

export const driftItemSchema = z
  .object({
    plan_id: z.string().regex(PLAN_ID_REGEX),
    title: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

export type DriftItem = z.infer<typeof driftItemSchema>;

export const riskFindingSchema = z
  .object({
    level: z.enum(RISK_LEVELS),
    category: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();

export type RiskFinding = z.infer<typeof riskFindingSchema>;

export const auditOutputSchema = z
  .object({
    // 0–100. The LLM's own subjective risk score, used as one factor in the
    // computed drift score. Kept separate from the formula so the caller
    // can reason about inputs.
    risk_score: z.number().min(0).max(100),
    requirements: z.array(requirementItemSchema).min(1),
    drift: z.array(driftItemSchema).default([]),
    risks: z.array(riskFindingSchema).default([]),
    recommended_actions: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type AuditOutput = z.infer<typeof auditOutputSchema>;
