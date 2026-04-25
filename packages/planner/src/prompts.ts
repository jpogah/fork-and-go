// Prompt loaders. Prompts are versioned markdown files under ./prompts/ so
// we can diff them in code review; this module wraps `readFileSync` behind a
// tiny API so callers don't have to resolve paths themselves.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface PlannerPrompts {
  decompose: string;
  draft: string;
}

export function loadPlannerPrompts(): PlannerPrompts {
  return {
    decompose: readFileSync(
      path.join(HERE, "prompts", "decompose-system.md"),
      "utf8",
    ),
    draft: readFileSync(path.join(HERE, "prompts", "draft-system.md"), "utf8"),
  };
}
