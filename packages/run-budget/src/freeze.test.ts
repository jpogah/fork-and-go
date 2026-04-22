import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FREEZE_FILENAME,
  freeze,
  freezePath,
  isFrozen,
  readFreezeNote,
  unfreeze,
} from "./freeze.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "run-budget-freeze-"));
}

describe("freeze / unfreeze / isFrozen", () => {
  it("creates and removes the sentinel file", () => {
    const dir = freshDir();
    expect(isFrozen(dir)).toBe(false);
    freeze(dir, { reason: "budget exhausted" });
    expect(isFrozen(dir)).toBe(true);
    expect(existsSync(path.join(dir, FREEZE_FILENAME))).toBe(true);

    const note = readFreezeNote(dir);
    expect(note?.reason).toBe("budget exhausted");
    expect(note?.at).toBeTypeOf("string");

    unfreeze(dir);
    expect(isFrozen(dir)).toBe(false);
  });

  it("is idempotent: double-unfreeze is a no-op", () => {
    const dir = freshDir();
    freeze(dir);
    unfreeze(dir);
    unfreeze(dir);
    expect(isFrozen(dir)).toBe(false);
  });

  it("readFreezeNote tolerates non-JSON bodies (legacy hand-touched files)", () => {
    const dir = freshDir();
    writeFileSync(freezePath(dir), "hand-written note\n");
    const note = readFreezeNote(dir);
    expect(note).toEqual({});
    expect(isFrozen(dir)).toBe(true);
  });

  it("returns null when no freeze file is present", () => {
    const dir = freshDir();
    expect(readFreezeNote(dir)).toBeNull();
  });
});
