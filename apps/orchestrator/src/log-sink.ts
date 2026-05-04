// Pluggable log sink for the runner. The default implementation writes
// to a per-run log file on the local filesystem (today's behavior). The
// cloud runner replaces it with a streaming writer that flushes batches
// to S3-compatible object storage (Cloudflare R2) so the API can serve
// log tails to the web UI.
//
// The interface is intentionally narrow: write a line, optionally end
// the stream. Errors must be swallowed inside the sink — log writes are
// best-effort and a slow or failing sink must not block the agent.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LogSink {
  // Append one line. Implementations should add the trailing newline
  // themselves and stamp a timestamp if the consumer expects one.
  write(line: string): void | Promise<void>;
  // Optional flush hook for sinks that buffer.
  flush?(): void | Promise<void>;
  // Optional end-of-run hook for sinks that close streams.
  end?(): void | Promise<void>;
  // The URI / path the run's log can be retrieved from afterwards.
  // FS impl returns a path; R2 impl returns an s3:// URI.
  uri(): string;
}

export interface FileLogSinkOptions {
  // Absolute path to write the log file at. Parent dirs are created.
  filePath: string;
  // Whether to stamp every line with an ISO timestamp. Defaults to true.
  stamp?: boolean;
  // Custom clock for testing.
  now?: () => Date;
}

// File-backed sink: matches the runner's pre-extraction behavior. Writes
// `[<iso>] <line>\n` to the configured path. Errors are swallowed.
export function createFileLogSink(opts: FileLogSinkOptions): LogSink {
  const stamp = opts.stamp !== false;
  const now = opts.now ?? (() => new Date());
  mkdirSync(path.dirname(opts.filePath), { recursive: true });
  // Truncate / create on construction so subsequent appends start clean.
  writeFileSync(opts.filePath, "", "utf8");
  return {
    write(line) {
      const text = stamp
        ? `[${now().toISOString()}] ${line}\n`
        : `${line}\n`;
      try {
        appendFileSync(opts.filePath, text, "utf8");
      } catch {
        // Best-effort.
      }
    },
    uri() {
      return opts.filePath;
    },
  };
}

// In-memory sink — useful for tests. Bounded by `limit` lines.
export function createMemoryLogSink(
  limit = 10_000,
): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
      while (lines.length > limit) lines.shift();
    },
    uri() {
      return ":memory:";
    },
  };
}
