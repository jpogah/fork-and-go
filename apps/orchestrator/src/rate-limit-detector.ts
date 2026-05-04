// Thin re-export of the shared rate-limit detector (plan 0052). The canonical
// implementation lives in `@harness/run-budget`; this file remains so existing
// call sites (run-invoker.ts, tests) keep working without an import rewrite.
// New code should import from `@harness/run-budget` directly.

export {
  containsRateLimitMarker,
  RATE_LIMIT_MARKER,
  RATE_LIMIT_REGEX,
  scanLogForRateLimit,
  tailReason,
} from "@harness/run-budget";
export type { RateLimitScanOptions } from "@harness/run-budget";
