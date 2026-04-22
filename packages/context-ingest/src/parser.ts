// Parser for operator-supplied context files.
//
// A context file is a markdown file with a YAML frontmatter header carrying
// `source` and `scope`, followed by a free-form body. Files that fail to
// parse are "advisory" — the caller receives a warning and can decide to
// surface it, but a malformed file never aborts the run.

import YAML from "yaml";
import { ZodError } from "zod";

import { contextHeaderSchema, type ContextHeader } from "./schema.ts";

const FRONTMATTER_DELIMITER = "---";

export interface ContextFile {
  filename: string;
  header: ContextHeader;
  body: string;
  // Filesystem mtime in millis, for reverse-chronological tiebreaks when the
  // aggregate cap needs to drop the lowest-priority files.
  mtimeMs: number;
}

export interface ContextParseWarning {
  filename: string;
  reason: string;
}

export type ParseResult =
  | { ok: true; file: ContextFile }
  | { ok: false; warning: ContextParseWarning };

export function parseContextFile(
  filename: string,
  text: string,
  mtimeMs: number,
): ParseResult {
  const split = splitFrontmatter(text);
  if (!split.ok) {
    return {
      ok: false,
      warning: { filename, reason: split.reason },
    };
  }

  let rawHeader: unknown;
  try {
    rawHeader = YAML.parse(split.frontmatter);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: {
        filename,
        reason: `invalid YAML frontmatter: ${message}`,
      },
    };
  }

  let header: ContextHeader;
  try {
    header = contextHeaderSchema.parse(rawHeader);
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        warning: {
          filename,
          reason: `frontmatter failed validation: ${formatZodError(err)}`,
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: {
        filename,
        reason: `frontmatter failed validation: ${message}`,
      },
    };
  }

  return {
    ok: true,
    file: {
      filename,
      header,
      body: split.body,
      mtimeMs,
    },
  };
}

function splitFrontmatter(
  text: string,
):
  | { ok: true; frontmatter: string; body: string }
  | { ok: false; reason: string } {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0] !== FRONTMATTER_DELIMITER) {
    return {
      ok: false,
      reason: `expected YAML frontmatter delimited by '---' on line 1`,
    };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return {
      ok: false,
      reason: `unterminated YAML frontmatter (missing closing '---')`,
    };
  }
  return {
    ok: true,
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines
      .slice(endIndex + 1)
      .join("\n")
      .replace(/^\n+/u, ""),
  };
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
