import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface SiteReversePrompts {
  analyze: string;
}

export function loadSiteReversePrompts(): SiteReversePrompts {
  return {
    analyze: readFileSync(
      path.join(HERE, "prompts", "analyze-system.md"),
      "utf8",
    ),
  };
}
