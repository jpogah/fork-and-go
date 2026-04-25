// Prompt loader. Same pattern as @fork-and-go/planner: prompts are versioned
// markdown files under ./prompts/ so they diff in code review.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface FidelityPrompts {
  audit: string;
}

export function loadFidelityPrompts(): FidelityPrompts {
  return {
    audit: readFileSync(path.join(HERE, "prompts", "audit-system.md"), "utf8"),
  };
}
