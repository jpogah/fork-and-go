#!/usr/bin/env node
// Operator-facing CLI for the context drop folder + the runner's rendering
// helper. Both invocations share the same loader, matcher, and size caps
// from @fork-and-go/context-ingest so the prompt the planner + runner see is
// identical to the preview an operator can request from this CLI.
//
// Usage:
//   scripts/context.mjs add <source> <scope>            # reads body on stdin
//   scripts/context.mjs list
//   scripts/context.mjs archive <filename>
//   scripts/context.mjs prune [--older-than 30d]        # default 30d
//   scripts/context.mjs render --planner                # planner-target section
//   scripts/context.mjs render --plan-id <id> [--phase <name>]
//
// The `render` subcommand is called by scripts/run_task.sh to inject the
// rendered `## External Context` block into implementer / review / fix
// prompts.

import { createInterface } from "node:readline";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_SOURCES,
  isValidScope,
  loadAndRender,
  loadContextInbox,
} from "@fork-and-go/context-ingest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const CONTEXT_ROOT = path.join(REPO_ROOT, "docs", "context");
const INBOX_DIR = path.join(CONTEXT_ROOT, "inbox");
const ARCHIVE_DIR = path.join(CONTEXT_ROOT, "archive");

function usage() {
  return [
    "Usage:",
    "  scripts/context.mjs add <source> <scope>",
    "  scripts/context.mjs list",
    "  scripts/context.mjs archive <filename>",
    "  scripts/context.mjs prune [--older-than 30d]",
    "  scripts/context.mjs render --planner",
    "  scripts/context.mjs render --plan-id <id> [--phase <name>]",
    "",
    `Sources: ${CONTEXT_SOURCES.join(", ")}`,
    "Scopes:  all | planner | run:<4-digit-id> | phase:<name>",
    "",
    `Context drops live in ${path.relative(REPO_ROOT, INBOX_DIR)}/ and archive in ${path.relative(REPO_ROOT, ARCHIVE_DIR)}/.`,
  ].join("\n");
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  try {
    switch (sub) {
      case "add":
        return await cmdAdd(rest);
      case "list":
        return cmdList();
      case "archive":
        return cmdArchive(rest);
      case "prune":
        return cmdPrune(rest);
      case "render":
        return cmdRender(rest);
      default:
        process.stderr.write(
          `context: unknown subcommand '${sub}'\n\n${usage()}\n`,
        );
        return 2;
    }
  } catch (err) {
    process.stderr.write(
      `context: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function cmdAdd(args) {
  const [source, scope] = args;
  if (!source || !scope) {
    process.stderr.write(
      `context add: expected <source> <scope>\n\n${usage()}\n`,
    );
    return 2;
  }
  if (!CONTEXT_SOURCES.includes(source)) {
    process.stderr.write(
      `context add: unknown source '${source}'. Expected one of: ${CONTEXT_SOURCES.join(", ")}\n`,
    );
    return 2;
  }
  if (!isValidScope(scope)) {
    process.stderr.write(
      `context add: invalid scope '${scope}'. Expected: all | planner | run:<4-digit-id> | phase:<name>\n`,
    );
    return 2;
  }

  const body = await readStdin();
  if (!body.trim()) {
    process.stderr.write(
      "context add: empty body on stdin. Pipe the text in or redirect a file:\n" +
        "  ./scripts/context.sh add slack run:0041 < note.md\n",
    );
    return 2;
  }

  ensureDir(INBOX_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const slug =
    scope
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-|-$/g, "") || "drop";
  const baseName = `${today}-${slug}`;
  const filename = nextAvailableFilename(INBOX_DIR, baseName);
  const filePath = path.join(INBOX_DIR, filename);
  const content = `---\nsource: "${source}"\nscope: "${scope}"\n---\n\n${body.trim()}\n`;
  writeFileSync(filePath, content, "utf8");
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, filePath)}\n`);
  return 0;
}

function cmdList() {
  const describe = (dir) => {
    if (!safeExists(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    return entries.map((name) => {
      const text = readFileSync(path.join(dir, name), "utf8");
      const stats = statSync(path.join(dir, name));
      return {
        name,
        summary: summarize(text),
        mtime: stats.mtime.toISOString().slice(0, 10),
      };
    });
  };
  const inbox = describe(INBOX_DIR);
  const archive = describe(ARCHIVE_DIR);

  process.stdout.write(`inbox (${inbox.length}):\n`);
  for (const entry of inbox) {
    process.stdout.write(
      `  ${entry.mtime}  ${entry.name}  — ${entry.summary}\n`,
    );
  }
  if (inbox.length === 0) process.stdout.write("  (empty)\n");

  process.stdout.write(`\narchive (${archive.length}):\n`);
  for (const entry of archive) {
    process.stdout.write(
      `  ${entry.mtime}  ${entry.name}  — ${entry.summary}\n`,
    );
  }
  if (archive.length === 0) process.stdout.write("  (empty)\n");
  return 0;
}

function cmdArchive(args) {
  const [filename] = args;
  if (!filename) {
    process.stderr.write(
      `context archive: expected <filename>\n\n${usage()}\n`,
    );
    return 2;
  }
  if (filename.includes("/") || filename.includes("..")) {
    process.stderr.write(
      "context archive: filename must be a bare name inside inbox/\n",
    );
    return 2;
  }
  const src = path.join(INBOX_DIR, filename);
  if (!safeExists(src)) {
    process.stderr.write(`context archive: ${filename} not found in inbox\n`);
    return 2;
  }
  ensureDir(ARCHIVE_DIR);
  const dest = path.join(ARCHIVE_DIR, filename);
  renameSync(src, dest);
  process.stdout.write(`archived ${path.relative(REPO_ROOT, dest)}\n`);
  return 0;
}

function cmdPrune(args) {
  const days = parseOlderThan(args);
  if (days === null) {
    process.stderr.write(
      `context prune: invalid --older-than value\n\n${usage()}\n`,
    );
    return 2;
  }
  if (!safeExists(INBOX_DIR)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readdirSync(INBOX_DIR, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  );
  ensureDir(ARCHIVE_DIR);
  let archived = 0;
  for (const entry of entries) {
    const src = path.join(INBOX_DIR, entry.name);
    const stats = statSync(src);
    if (stats.mtimeMs > cutoff) continue;
    const dest = path.join(ARCHIVE_DIR, entry.name);
    renameSync(src, dest);
    archived += 1;
    process.stdout.write(`archived ${entry.name}\n`);
  }
  process.stdout.write(
    `pruned ${archived} file(s) older than ${days} day(s).\n`,
  );
  return 0;
}

function cmdRender(args) {
  let planId = null;
  let phase;
  let planner = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--planner") {
      planner = true;
      continue;
    }
    if (arg === "--plan-id") {
      planId = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--phase") {
      phase = args[i + 1];
      i += 1;
      continue;
    }
    process.stderr.write(
      `context render: unknown flag '${arg}'\n\n${usage()}\n`,
    );
    return 2;
  }

  let target;
  if (planner && planId !== null) {
    process.stderr.write(
      "context render: --planner and --plan-id are mutually exclusive\n",
    );
    return 2;
  }
  if (planner) {
    target = { kind: "planner" };
  } else if (planId !== null) {
    if (!/^\d{4}$/.test(planId)) {
      process.stderr.write(
        "context render: --plan-id must be a zero-padded 4-digit id\n",
      );
      return 2;
    }
    target = { kind: "run", planId };
    if (phase) target.phase = phase;
  } else {
    process.stderr.write(
      `context render: pass --planner or --plan-id <id>\n\n${usage()}\n`,
    );
    return 2;
  }

  const result = loadAndRender({ inboxDir: INBOX_DIR, target });
  for (const warning of result.warnings) {
    process.stderr.write(
      `context render: warning — ${warning.filename}: ${warning.reason}\n`,
    );
  }
  if (result.section) {
    process.stdout.write(result.section);
  }
  return 0;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      buf += line + "\n";
    });
    rl.on("close", () => resolve(buf));
  });
}

function summarize(text) {
  // First body line (after frontmatter) or empty string. Trimmed to 80 chars.
  const lines = text.split("\n");
  const hasFrontmatter = lines[0]?.trim() === "---";
  let bodyStart = 0;
  if (hasFrontmatter) {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        bodyStart = i + 1;
        break;
      }
    }
  }
  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  }
  return "";
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function safeExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function nextAvailableFilename(dir, base) {
  let candidate = `${base}.md`;
  let counter = 2;
  while (safeExists(path.join(dir, candidate))) {
    candidate = `${base}-${counter}.md`;
    counter += 1;
  }
  return candidate;
}

function parseOlderThan(args) {
  // Default: 30d when no flag supplied; otherwise parse `<n>d`.
  let raw = "30d";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--older-than") {
      raw = args[i + 1] ?? "";
      i += 1;
    }
  }
  const match = /^(\d+)d$/.exec(raw);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(
      `context: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  },
);
