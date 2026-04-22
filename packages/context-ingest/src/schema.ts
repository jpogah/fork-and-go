import { z } from "zod";

// Operator-supplied context files carry a tiny YAML frontmatter. `source` is
// free-form metadata for the operator; `scope` is the control knob the
// matcher uses to decide which prompts see the file.
//
// Scope grammar:
//   all            every planner + implementer invocation sees this
//   planner        only the planner's ingest phase
//   run:<id>       only the implementer/review prompts for plan <id>
//   phase:<name>   any plan whose frontmatter `phase` equals <name>
export const CONTEXT_SOURCES = [
  "slack",
  "email",
  "jira",
  "wiki",
  "other",
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export const contextHeaderSchema = z
  .object({
    source: z.enum(CONTEXT_SOURCES),
    scope: z.string().min(1).refine(isValidScope, {
      message:
        "scope must be one of: all | planner | run:<4-digit-id> | phase:<name>",
    }),
  })
  .strict();

export type ContextHeader = z.infer<typeof contextHeaderSchema>;

export function isValidScope(value: string): boolean {
  if (value === "all") return true;
  if (value === "planner") return true;
  if (/^run:\d{4}$/u.test(value)) return true;
  if (/^phase:[A-Za-z0-9 _-]{1,60}$/u.test(value)) return true;
  return false;
}

// Precedence used by the matcher when deciding which scoped files to include
// for a given target. Lower numbers sort first (higher priority). The
// aggregate-cap trim uses this ordering in reverse (lowest priority dropped
// first). Matches the plan's `all > phase > planner > run` hierarchy.
export function scopePriority(scope: string): number {
  if (scope === "all") return 0;
  if (scope.startsWith("phase:")) return 1;
  if (scope === "planner") return 2;
  if (scope.startsWith("run:")) return 3;
  return 99;
}
