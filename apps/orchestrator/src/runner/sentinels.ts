// Sentinel parsers — preserve the bash semantics from run_task.sh:
//   review_is_clean     — first non-empty line is "No findings." or "No
//                         blocking findings.", OR a standalone-line
//                         occurrence of either anywhere in the body.
//   merge_is_ready      — same, but the sentinel is "No findings. Ready to
//                         enable auto-merge."
//   first_nonempty_line — first non-blank line of the body.

export function firstNonEmptyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() !== "") return line;
  }
  return "";
}

export function reviewIsClean(body: string): boolean {
  if (!body) return false;
  const first = firstNonEmptyLine(body).trim();
  if (
    first.startsWith("No findings.") ||
    first.startsWith("No blocking findings.")
  ) {
    return true;
  }
  // Defensive fallback: sentinel may appear as a standalone line after a
  // preamble. Anchor on whole-line matches, ignoring trailing whitespace.
  return /^(No findings\.|No blocking findings\.)\s*$/m.test(body);
}

export function mergeIsReady(body: string): boolean {
  if (!body) return false;
  const first = firstNonEmptyLine(body).trim();
  if (first.startsWith("No findings. Ready to enable auto-merge.")) {
    return true;
  }
  return /^No findings\. Ready to enable auto-merge\.\s*$/m.test(body);
}

export function e2eVerificationPassed(body: string): boolean {
  if (!body) return false;
  return firstNonEmptyLine(body).trim() === "E2E verification passed.";
}
