#!/usr/bin/env node
// Thin shell-facing wrapper around @fork-and-go/run-budget's rate-limit detector.
// Exits 0 when the supplied log tail matches a rate-limit marker, 1 when it
// does not (or the file does not exist). Used by scripts/run_task.sh and
// scripts/run_task_loop.sh so the shell scripts don't duplicate the regex.
//
// Usage: ./scripts/rate-limit-detect.mjs <log-file>

import { scanLogForRateLimit } from "../packages/run-budget/src/rate-limit-detector.ts";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: rate-limit-detect.mjs <log-file>\n");
  process.exit(2);
}

process.exit(scanLogForRateLimit(file) ? 0 : 1);
