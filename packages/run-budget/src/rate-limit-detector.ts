// Shared rate-limit detection. Consumed by:
//   - scripts/run_task.sh (via rate-limit-detect.mjs helper)
//   - scripts/run_task_loop.sh (via the same helper)
//   - apps/orchestrator (direct import)
//
// The canonical Claude CLI message is `You've hit your limit · resets <time>`.
// Other observed variants include OpenAI "You exceeded your current quota" and
// a generic "rate limit reached" emitted by some gateway proxies. The regex
// below is intentionally narrow — it must not match arbitrary diagnostic text
// that merely mentions "limit" (e.g. a comment about a test case with "hit my
// limit in that scenario"). Keep it tight; revisit when new variants appear.

import { readFileSync, statSync } from "node:fs";

export const RATE_LIMIT_MARKER = "hit your limit";

// Matching rules:
//   - "hit your limit"       — canonical Claude usage-limit phrase.
//   - "exceeded your ... quota" — OpenAI 429 body.
//   - "rate limit reached"   — gateway proxies (generic).
//   - "rate_limit_exceeded"  — OpenAI error `code` field.
// Case-insensitive. `.` does not cross newlines, matching original intent.
export const RATE_LIMIT_REGEX =
  /hit your limit|exceeded your[^\n]{0,80}quota|rate limit reached|rate_limit_exceeded/i;

export interface RateLimitScanOptions {
  // How many trailing bytes of the log to scan. The marker always appears
  // near the end of the run; scanning the tail keeps big logs fast.
  tailBytes?: number;
  // When provided, these are used instead of the default regex. Tests use
  // this to inject custom markers.
  markers?: readonly string[];
}

export function containsRateLimitMarker(
  text: string,
  markers?: readonly string[],
): boolean {
  if (markers && markers.length > 0) {
    const lower = text.toLowerCase();
    return markers.some((m) => lower.includes(m.toLowerCase()));
  }
  return RATE_LIMIT_REGEX.test(text);
}

export function scanLogForRateLimit(
  logPath: string,
  options: RateLimitScanOptions = {},
): boolean {
  const tailBytes = options.tailBytes ?? 64 * 1024;
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const start = Math.max(0, size - tailBytes);
  let text: string;
  try {
    const buf = readFileSync(logPath);
    text = buf.toString("utf8", start, size);
  } catch {
    return false;
  }
  return containsRateLimitMarker(text, options.markers);
}

// For `blocked` entries, we want a short reason snippet pulled from the tail
// of the log. Returns the last non-empty lines joined, capped at a small
// size so the state file does not balloon.
export function tailReason(logPath: string, lines = 8, maxLen = 600): string {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return "run_task.sh produced no log";
  }
  if (size === 0) return "run_task.sh produced no log";
  const start = Math.max(0, size - 32 * 1024);
  let text: string;
  try {
    text = readFileSync(logPath).toString("utf8", start, size);
  } catch {
    return "unable to read run_task.sh log";
  }
  const candidates = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const picked = candidates.slice(-lines).join("\n");
  if (picked.length <= maxLen) return picked;
  return picked.slice(picked.length - maxLen);
}
