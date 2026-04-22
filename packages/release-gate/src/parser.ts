// Parser for the acceptance-file markdown format. The format is intentionally
// structured so we can parse it with a line-scanner rather than a full AST.
//
// Shape:
//
//   # Title (any text)
//
//   ## Release criteria
//
//   - [ ] **tag: `auth/google-signin`** — "description"
//     - Tested by: `path/to/test.spec.ts`
//     - Covered by plans: 0012, 0037
//     - Required connections: Google OAuth
//   - [ ] **tag: `...`** — "..."
//
//   ## Environment requirements
//
//   - `DATABASE_URL` (optional note)
//   - `OPENAI_API_KEY`, `GMAIL_CLIENT_ID`
//
// Top-level bullets under `## Release criteria` are criteria. Sub-bullets
// (indented) add metadata. A second-level heading of any other name is
// ignored (comments / operator notes). We surface hard errors for a missing
// `## Release criteria` section or a malformed criterion header.

import { readFileSync } from "node:fs";

import type { AcceptanceCriterion, AcceptanceSpec } from "./types.ts";

export type { AcceptanceSpec } from "./types.ts";

export class AcceptanceParseError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "AcceptanceParseError";
  }
}

const RELEASE_CRITERIA_HEADING = /^##\s+Release criteria\s*$/iu;
const ENV_REQUIREMENTS_HEADING = /^##\s+Environment requirements\s*$/iu;
const HEADING_PATTERN = /^#{1,6}\s+/u;
const TOP_BULLET_PATTERN = /^-\s+/u;
const SUB_BULLET_PATTERN = /^(?:\s{2,}|\t)-\s+/u;
const TAG_HEADER_PATTERN =
  /\*\*\s*tag\s*:\s*`([^`]+)`\s*\*\*\s*(?:[—\-–:]\s*)?(.*)$/u;

export function parseAcceptanceFile(filePath: string): AcceptanceSpec {
  const text = readFileSync(filePath, "utf8");
  return parseAcceptanceContent(filePath, text);
}

export function parseAcceptanceContent(
  filePath: string,
  text: string,
): AcceptanceSpec {
  const lines = text.split(/\r?\n/u);
  const title = findTitle(lines);

  const sections = findSections(lines);
  if (!sections.releaseCriteria) {
    throw new AcceptanceParseError(
      filePath,
      "missing `## Release criteria` section",
    );
  }

  const criteria = parseCriteria(
    filePath,
    lines,
    sections.releaseCriteria.start,
    sections.releaseCriteria.endExclusive,
  );
  const envRequirements = sections.environmentRequirements
    ? parseEnvRequirements(
        lines,
        sections.environmentRequirements.start,
        sections.environmentRequirements.endExclusive,
      )
    : [];

  assertUniqueTags(filePath, criteria);

  return {
    title,
    criteria,
    environmentRequirements: envRequirements,
    filePath,
  };
}

interface SectionRange {
  start: number;
  endExclusive: number;
}

function findSections(lines: string[]): {
  releaseCriteria: SectionRange | null;
  environmentRequirements: SectionRange | null;
} {
  let releaseCriteria: SectionRange | null = null;
  let environmentRequirements: SectionRange | null = null;
  let current: { kind: "release" | "env"; start: number } | null = null;

  const close = (endExclusive: number): void => {
    if (!current) return;
    const range = { start: current.start, endExclusive };
    if (current.kind === "release") releaseCriteria = range;
    if (current.kind === "env") environmentRequirements = range;
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (RELEASE_CRITERIA_HEADING.test(line)) {
      close(i);
      current = { kind: "release", start: i + 1 };
      continue;
    }
    if (ENV_REQUIREMENTS_HEADING.test(line)) {
      close(i);
      current = { kind: "env", start: i + 1 };
      continue;
    }
    if (HEADING_PATTERN.test(line) && current) {
      close(i);
    }
  }
  close(lines.length);
  return { releaseCriteria, environmentRequirements };
}

function parseCriteria(
  filePath: string,
  lines: string[],
  start: number,
  endExclusive: number,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  let current: AcceptanceCriterion | null = null;

  const finalize = (): void => {
    if (current) {
      criteria.push(current);
      current = null;
    }
  };

  for (let i = start; i < endExclusive; i += 1) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    if (SUB_BULLET_PATTERN.test(raw)) {
      if (!current) {
        throw new AcceptanceParseError(
          filePath,
          `line ${i + 1}: sub-bullet without a parent criterion`,
        );
      }
      applySubBullet(current, raw);
      continue;
    }
    if (TOP_BULLET_PATTERN.test(raw)) {
      finalize();
      const body = raw.replace(TOP_BULLET_PATTERN, "").trim();
      // Optional checkbox prefix: `[ ]` or `[x]` or `[X]`.
      const withoutCheckbox = body.replace(/^\[[ xX]\]\s*/u, "");
      const match = TAG_HEADER_PATTERN.exec(withoutCheckbox);
      if (!match) {
        throw new AcceptanceParseError(
          filePath,
          `line ${i + 1}: criterion must start with \`**tag: \`<tag>\`**\``,
        );
      }
      const tag = (match[1] ?? "").trim();
      if (!tag) {
        throw new AcceptanceParseError(filePath, `line ${i + 1}: empty tag`);
      }
      const description = stripWrappingQuotes((match[2] ?? "").trim());
      current = {
        tag,
        description,
        testedBy: [],
        coveredByPlans: [],
        requiredConnections: [],
        line: i + 1,
      };
      continue;
    }
    // Any other content inside a criterion section (prose, HTML comments)
    // is ignored — operators may add commentary freely.
  }
  finalize();
  return criteria;
}

function applySubBullet(target: AcceptanceCriterion, raw: string): void {
  const body = raw.replace(SUB_BULLET_PATTERN, "").trim();
  const colonIndex = body.indexOf(":");
  if (colonIndex === -1) return;
  const key = body.slice(0, colonIndex).trim().toLowerCase();
  const value = body.slice(colonIndex + 1).trim();
  if (key === "tested by" || key === "test" || key === "tests") {
    for (const path of extractInlineCodePaths(value)) {
      target.testedBy.push(path);
    }
  } else if (
    key === "covered by plans" ||
    key === "covered by plan" ||
    key === "plans"
  ) {
    for (const id of extractPlanIds(value)) {
      target.coveredByPlans.push(id);
    }
  } else if (
    key === "required connections" ||
    key === "requires" ||
    key === "connections"
  ) {
    const clean = value.replace(/^\s*[-–—]\s*/u, "").trim();
    if (clean) target.requiredConnections.push(clean);
  }
}

function parseEnvRequirements(
  lines: string[],
  start: number,
  endExclusive: number,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = start; i < endExclusive; i += 1) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    if (!TOP_BULLET_PATTERN.test(raw) && !SUB_BULLET_PATTERN.test(raw)) {
      continue;
    }
    const body = raw
      .replace(TOP_BULLET_PATTERN, "")
      .replace(SUB_BULLET_PATTERN, "")
      .trim();
    for (const ident of extractInlineCodeIdents(body)) {
      if (!seen.has(ident)) {
        seen.add(ident);
        names.push(ident);
      }
    }
  }
  return names;
}

function findTitle(lines: string[]): string {
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match) return match[1] ?? "";
  }
  return "";
}

function extractInlineCodePaths(value: string): string[] {
  const matches = value.matchAll(/`([^`]+)`/gu);
  const out: string[] = [];
  for (const m of matches) {
    const s = (m[1] ?? "").trim();
    if (s) out.push(s);
  }
  return out;
}

function extractInlineCodeIdents(value: string): string[] {
  return extractInlineCodePaths(value).filter((s) =>
    /^[A-Z][A-Z0-9_]*$/u.test(s),
  );
}

function extractPlanIds(value: string): string[] {
  const matches = value.matchAll(/\b(\d{4})\b/gu);
  const out: string[] = [];
  for (const m of matches) {
    const s = m[1];
    if (s) out.push(s);
  }
  return out;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "“" && last === "”") ||
      (first === "‘" && last === "’")
    ) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function assertUniqueTags(
  filePath: string,
  criteria: ReadonlyArray<AcceptanceCriterion>,
): void {
  const seen = new Map<string, number>();
  for (const c of criteria) {
    const prior = seen.get(c.tag);
    if (prior !== undefined) {
      throw new AcceptanceParseError(
        filePath,
        `duplicate tag '${c.tag}' (first at line ${prior}, again at line ${c.line})`,
      );
    }
    seen.set(c.tag, c.line);
  }
}
