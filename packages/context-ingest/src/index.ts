// Public surface of @fork-and-go/context-ingest. Downstream callers (runner
// helpers, planner ingest, CLI) import from here.

export {
  CONTEXT_SOURCES,
  contextHeaderSchema,
  isValidScope,
  scopePriority,
  type ContextHeader,
  type ContextSource,
} from "./schema.ts";

export {
  parseContextFile,
  type ContextFile,
  type ContextParseWarning,
  type ParseResult,
} from "./parser.ts";

export {
  loadContextInbox,
  type LoadContextOptions,
  type LoadContextResult,
} from "./loader.ts";

export {
  matchContext,
  scopeMatches,
  AGGREGATE_CAP_CHARS,
  PER_FILE_CAP_CHARS,
  UNTRUSTED_LABEL,
  type MatchResult,
  type MatchTarget,
  type MatchedFile,
} from "./matcher.ts";

export {
  loadAndRender,
  type RenderOptions,
  type RenderResult,
} from "./render.ts";
