#!/usr/bin/env node
// Extracts the final response text or the reported token usage from a captured
// agent log (plan 0052).
//
// Claude's `-p --output-format json` emits a single JSON object with a
// top-level `result` string and a `usage` block. Codex's `--json` emits JSONL
// events; the final-turn `turn.completed` event carries `usage`, and
// `item.completed` events with `item.type === "agent_message"` carry the
// human-readable response. Rate-limit and auth errors can land in either shape
// (Codex prints non-JSON stderr lines) so parsing is tolerant: invalid lines
// are skipped.
//
// Usage:
//   agent-log.mjs result <log-file> <agent>
//   agent-log.mjs tokens <log-file> <agent>
//
// `result` writes the response text to stdout (trailing newline enforced).
// `tokens` writes `<inputTokens>\t<outputTokens>\t<model>` to stdout. The
// model column lets run_task.sh record the agent-reported model name when the
// operator didn't pass `--model`, so the budget aggregator doesn't fall back
// to the generic flat rate (which under-counts claude-opus runs by ~3x).
// Both exit 0 on success, 1 if the log is unparsable or the requested data is
// not present (so callers can fall back to zero without aborting the phase).

import { readFileSync } from "node:fs";

const command = process.argv[2];
const file = process.argv[3];
const agent = process.argv[4];

if (!command || !file || !agent) {
  process.stderr.write(
    "usage: agent-log.mjs <result|tokens> <log-file> <agent>\n",
  );
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  process.exit(1);
}

if (agent === "claude") {
  const obj = parseClaudeJson(text);
  if (!obj) process.exit(1);
  if (command === "result") {
    const result = typeof obj.result === "string" ? obj.result : "";
    writeLine(result);
    process.exit(0);
  }
  if (command === "tokens") {
    const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : null;
    if (!usage) process.exit(1);
    // Sum all input-side counters so cache creation and cache reads (both
    // billable) count toward the ceiling, not just the fresh input tokens.
    const input =
      toNum(usage.input_tokens) +
      toNum(usage.cache_creation_input_tokens) +
      toNum(usage.cache_read_input_tokens);
    const output = toNum(usage.output_tokens);
    const model = claudeModel(obj);
    process.stdout.write(`${input}\t${output}\t${model}\n`);
    process.exit(0);
  }
} else if (agent === "codex") {
  let totalInput = 0;
  let totalOutput = 0;
  let sawUsage = false;
  let lastMessage = "";
  let model = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn.completed" && event.usage) {
      totalInput +=
        toNum(event.usage.input_tokens) +
        toNum(event.usage.cached_input_tokens);
      totalOutput += toNum(event.usage.output_tokens);
      sawUsage = true;
    }
    if (
      event.type === "item.completed" &&
      event.item &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      lastMessage = event.item.text;
    }
    if (!model) {
      if (typeof event.model === "string") model = event.model;
      else if (event.session && typeof event.session.model === "string")
        model = event.session.model;
    }
  }
  if (command === "result") {
    if (!lastMessage) process.exit(1);
    writeLine(lastMessage);
    process.exit(0);
  }
  if (command === "tokens") {
    if (!sawUsage) process.exit(1);
    process.stdout.write(`${totalInput}\t${totalOutput}\t${model}\n`);
    process.exit(0);
  }
}

process.stderr.write(`unknown command or agent: ${command} ${agent}\n`);
process.exit(2);

function claudeModel(obj) {
  // Claude's `-p --output-format json` reports the resolved model in a few
  // spots depending on the CLI version. Check the top-level `model` field
  // first, then `usage.model`, then `message.model`.
  if (typeof obj.model === "string") return obj.model;
  if (obj.usage && typeof obj.usage.model === "string") return obj.usage.model;
  if (obj.message && typeof obj.message.model === "string")
    return obj.message.model;
  return "";
}

function parseClaudeJson(raw) {
  // Claude `-p --output-format json` prints exactly one JSON object. Any
  // preceding stderr noise is captured via `2>&1` in the caller, so fall
  // back to scanning for the last top-level object when direct JSON.parse
  // fails.
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {
    // fall through
  }
  const match = raw.match(/\{[\s\S]*\}\s*$/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj && typeof obj === "object") return obj;
  } catch {
    return null;
  }
  return null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeLine(s) {
  process.stdout.write(s);
  if (!s.endsWith("\n")) process.stdout.write("\n");
}
