import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createStateStore,
  emptyState,
  readStateFile,
  writeAtomic,
  HISTORY_LIMIT,
  STATE_FILE_VERSION,
} from "./state.ts";

describe("state store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "orchestrator-state-"));
  });
  afterEach(() => {
    // Vitest clean-up isn't strictly necessary; tmpdir gets reaped. Leaving
    // the directory behind keeps these tests idempotent.
  });

  it("creates an empty state file on first access", () => {
    const store = createStateStore({ dir });
    const s = store.get();
    expect(s.version).toBe(STATE_FILE_VERSION);
    expect(s.mode).toBe("paused");
    expect(s.history).toEqual([]);
    expect(existsSync(store.path())).toBe(true);
  });

  it("reads back an existing state file on startup", () => {
    const first = createStateStore({ dir });
    first.update((d) => {
      d.mode = "idle";
      d.runsFired = 3;
    });
    const second = createStateStore({ dir });
    expect(second.get().mode).toBe("idle");
    expect(second.get().runsFired).toBe(3);
  });

  it("writes atomically via temp + rename", () => {
    const filePath = path.join(dir, "atomic.json");
    writeAtomic(filePath, { version: 1, hello: "world" });
    const raw = readFileSync(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, hello: "world" });
    // No tmp files left behind.
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("migrates/refuses state with a wrong version", () => {
    const filePath = path.join(dir, "state.json");
    writeFileSync(
      filePath,
      JSON.stringify({ version: 999, mode: "running" }),
      "utf8",
    );
    expect(() => readStateFile(filePath)).toThrow(/version mismatch/);
  });

  it("trims history at the configured limit", () => {
    const store = createStateStore({ dir });
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      store.pushHistory({
        planId: String(i).padStart(4, "0"),
        event: "plan_started",
      });
    }
    const s = store.get();
    expect(s.history).toHaveLength(HISTORY_LIMIT);
    expect(s.history[0]?.planId).toBe("0005");
  });

  it("preserves mode and history through update()", () => {
    const store = createStateStore({ dir });
    store.update((d) => {
      d.mode = "running";
      d.active = {
        planId: "0050",
        branch: "task/0050",
        startedAt: "2026-04-22T00:00:00.000Z",
        logPath: ".orchestrator/logs/0050-x.log",
        rateLimitRetries: 0,
      };
    });
    expect(store.get().active?.planId).toBe("0050");
    expect(store.get().mode).toBe("running");
  });

  it("empty state round-trips through JSON", () => {
    const clone = JSON.parse(JSON.stringify(emptyState()));
    expect(clone.version).toBe(STATE_FILE_VERSION);
    expect(clone.active).toBeNull();
  });
});
