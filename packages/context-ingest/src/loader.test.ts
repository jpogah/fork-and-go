import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadContextInbox } from "./loader.ts";

describe("loadContextInbox", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ctx-inbox-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty result when the directory is missing", () => {
    const missing = path.join(dir, "missing");
    const result = loadContextInbox({ inboxDir: missing });
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads well-formed files and warns on malformed ones", () => {
    writeFileSync(
      path.join(dir, "2026-04-21-good.md"),
      `---\nsource: "slack"\nscope: "all"\n---\n\nOK`,
      "utf8",
    );
    writeFileSync(path.join(dir, "bad.md"), "no frontmatter at all", "utf8");
    writeFileSync(path.join(dir, "not-md.txt"), "ignored", "utf8");
    writeFileSync(path.join(dir, ".gitkeep"), "", "utf8");
    mkdirSync(path.join(dir, "sub"));

    const result = loadContextInbox({ inboxDir: dir });
    expect(result.files.map((f) => f.filename)).toEqual(["2026-04-21-good.md"]);
    expect(result.warnings.map((w) => w.filename)).toEqual(["bad.md"]);
    expect(result.files[0]!.header.scope).toBe("all");
  });

  it("populates mtimeMs from the filesystem", () => {
    const file = path.join(dir, "a.md");
    writeFileSync(
      file,
      `---\nsource: "slack"\nscope: "all"\n---\n\nhi`,
      "utf8",
    );
    const newTime = new Date("2026-04-15T10:00:00Z");
    utimesSync(file, newTime, newTime);
    const result = loadContextInbox({ inboxDir: dir });
    expect(result.files[0]!.mtimeMs).toBe(newTime.getTime());
  });
});
