import { z } from "zod";

export const PLAN_STATUSES = [
  "active",
  "in_progress",
  "completed",
  "blocked",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

// Frontmatter is YAML at the top of each plan markdown file, delimited by `---`.
// `id` matches the numeric prefix of the filename (zero-padded, 4 digits).
export const planFrontmatterSchema = z
  .object({
    id: z.string().regex(/^\d{4}$/u, "id must be a zero-padded 4-digit string"),
    title: z.string().min(1),
    phase: z.string().min(1),
    status: z.enum(PLAN_STATUSES),
    depends_on: z
      .array(z.string().regex(/^\d{4}$/u, "depends_on ids must be 4 digits"))
      .default([]),
    estimated_passes: z.number().int().positive(),
    acceptance_tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PlanFrontmatter = z.infer<typeof planFrontmatterSchema>;
