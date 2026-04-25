import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { ZodError } from "zod";

import { planFrontmatterSchema } from "./schema.ts";
import type { Plan, PlanLocation } from "./types.ts";

const FRONTMATTER_DELIMITER = "---";
const FILE_ID_PATTERN = /^(\d{4})-[a-z0-9-]+\.md$/u;

export class PlanParseError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "PlanParseError";
  }
}

export interface LoadPlansOptions {
  activeDir: string;
  completedDir: string;
}

export function loadPlans(options: LoadPlansOptions): Plan[] {
  const plans: Plan[] = [];
  for (const [dir, location] of [
    [options.activeDir, "active" as const],
    [options.completedDir, "completed" as const],
  ] satisfies Array<[string, PlanLocation]>) {
    plans.push(...loadPlansFromDir(dir, location));
  }
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return plans;
}

function loadPlansFromDir(dir: string, location: PlanLocation): Plan[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const plans: Plan[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const plan = loadPlanFile(filePath, location);
    plans.push(plan);
  }
  return plans;
}

export function loadPlanFile(filePath: string, location: PlanLocation): Plan {
  const text = readFileSync(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(filePath, text);
  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatter);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlanParseError(filePath, `invalid YAML frontmatter: ${message}`);
  }
  let validated;
  try {
    validated = planFrontmatterSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new PlanParseError(
        filePath,
        `frontmatter failed validation: ${formatZodError(err)}`,
      );
    }
    throw err;
  }
  return {
    id: validated.id,
    title: validated.title,
    phase: validated.phase,
    status: validated.status,
    dependsOn: [...validated.depends_on].sort(),
    estimatedPasses: validated.estimated_passes,
    acceptanceTags: [...validated.acceptance_tags],
    location,
    filePath,
    body,
    raw: validated,
  };
}

export function splitFrontmatter(
  filePath: string,
  text: string,
): { frontmatter: string; body: string } {
  const lines = text.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new PlanParseError(
      filePath,
      `expected YAML frontmatter delimited by '---' on line 1`,
    );
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new PlanParseError(
      filePath,
      `unterminated YAML frontmatter (missing closing '---')`,
    );
  }
  const frontmatter = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");
  return { frontmatter, body };
}

export function fileIdFromFilename(filename: string): string | null {
  const match = FILE_ID_PATTERN.exec(filename);
  return match ? (match[1] ?? null) : null;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
