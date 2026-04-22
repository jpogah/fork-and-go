// Convenience helper that the runner (scripts/context.mjs + run_task.sh) and
// the planner both use: load the inbox, filter by target, return the
// rendered `## External Context` prompt section along with the warnings the
// caller should surface.

import { loadContextInbox } from "./loader.ts";
import { matchContext, type MatchTarget } from "./matcher.ts";
import type { ContextParseWarning, ContextFile } from "./parser.ts";

export interface RenderOptions {
  inboxDir: string;
  target: MatchTarget;
}

export interface RenderResult {
  // The fully rendered `## External Context` block. Empty string when no
  // files matched (and no parse warnings were produced); callers can
  // conditionally skip appending to their prompt.
  section: string;
  // Files that matched the target scope and survived size caps.
  matched: ReadonlyArray<ContextFile>;
  // Files whose scope matched but were evicted by the aggregate cap.
  droppedForAggregateCap: ReadonlyArray<ContextFile>;
  // Parse-time warnings (malformed frontmatter, unreadable files, etc.).
  warnings: ReadonlyArray<ContextParseWarning>;
}

export function loadAndRender(options: RenderOptions): RenderResult {
  const { files, warnings } = loadContextInbox({ inboxDir: options.inboxDir });
  const match = matchContext(files, options.target);
  return {
    section: match.rendered,
    matched: match.matched.map((m) => m.file),
    droppedForAggregateCap: match.droppedForAggregateCap,
    warnings,
  };
}
