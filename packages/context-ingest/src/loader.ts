// Loader: read a directory of context files, parse each, and return the
// accepted files plus any warnings. The runner + planner call this before
// matching so both share the same parse-warning surface.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  parseContextFile,
  type ContextFile,
  type ContextParseWarning,
} from "./parser.ts";

export interface LoadContextOptions {
  // Directory holding `.md` files. Typically `docs/context/inbox/`.
  inboxDir: string;
}

export interface LoadContextResult {
  files: ReadonlyArray<ContextFile>;
  warnings: ReadonlyArray<ContextParseWarning>;
}

export function loadContextInbox(
  options: LoadContextOptions,
): LoadContextResult {
  const files: ContextFile[] = [];
  const warnings: ContextParseWarning[] = [];

  if (!existsSync(options.inboxDir)) {
    return { files, warnings };
  }

  const entries = readdirSync(options.inboxDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = path.join(options.inboxDir, entry.name);
    let text: string;
    let mtimeMs: number;
    try {
      text = readFileSync(filePath, "utf8");
      mtimeMs = statSync(filePath).mtimeMs;
    } catch (err) {
      warnings.push({
        filename: entry.name,
        reason: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const parsed = parseContextFile(entry.name, text, mtimeMs);
    if (parsed.ok) {
      files.push(parsed.file);
    } else {
      warnings.push(parsed.warning);
    }
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename));
  warnings.sort((a, b) => a.filename.localeCompare(b.filename));
  return { files, warnings };
}
