import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileLogSink, createMemoryLogSink } from "./log-sink.ts";

describe("file log sink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "log-sink-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes timestamped lines to the configured path", () => {
    const file = path.join(dir, "run.log");
    const sink = createFileLogSink({
      filePath: file,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    sink.write("first");
    sink.write("second");
    const text = readFileSync(file, "utf8");
    expect(text).toBe(
      "[2026-01-01T00:00:00.000Z] first\n[2026-01-01T00:00:00.000Z] second\n",
    );
    expect(sink.uri()).toBe(file);
  });

  it("can disable timestamps", () => {
    const file = path.join(dir, "run.log");
    const sink = createFileLogSink({ filePath: file, stamp: false });
    sink.write("raw");
    expect(readFileSync(file, "utf8")).toBe("raw\n");
  });

  it("creates missing parent directories", () => {
    const file = path.join(dir, "nested", "deep", "run.log");
    const sink = createFileLogSink({ filePath: file });
    sink.write("hi");
    expect(readFileSync(file, "utf8")).toContain("hi\n");
  });
});

describe("memory log sink", () => {
  it("buffers lines up to the limit", () => {
    const sink = createMemoryLogSink(2);
    sink.write("a");
    sink.write("b");
    sink.write("c");
    expect(sink.lines).toEqual(["b", "c"]);
    expect(sink.uri()).toBe(":memory:");
  });
});
