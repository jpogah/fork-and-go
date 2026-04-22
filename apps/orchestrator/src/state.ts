// State persistence for the orchestrator daemon. The daemon writes
// `.orchestrator/state.json` atomically (temp-file + rename) on every
// transition and reads it on startup. The shape is versioned so a future
// schema change can migrate forward.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const STATE_FILE_VERSION = 1 as const;

export type RunMode = "paused" | "running" | "idle" | "stopping";

export type HistoryEvent =
  | "plan_started"
  | "plan_completed"
  | "plan_blocked"
  | "rate_limit_backoff"
  | "graph_refreshed"
  | "merge_observed"
  | "budget_ceiling_reached"
  | "plan_over_budget"
  | "frozen"
  | "unfrozen"
  | "fidelity_check_ok"
  | "fidelity_blocked"
  | "release_candidate_ready";

export interface HistoryEntry {
  planId: string | null;
  event: HistoryEvent;
  at: string;
  details?: Record<string, unknown>;
}

export interface ActiveRun {
  planId: string;
  branch: string;
  startedAt: string;
  logPath: string;
  rateLimitRetries: number;
}

export interface BlockedEntry {
  reason: string;
  blockedAt: string;
  retries: number;
}

export interface OrchestratorState {
  version: typeof STATE_FILE_VERSION;
  mode: RunMode;
  lastMergeSha: string | null;
  active: ActiveRun | null;
  blocked: Record<string, BlockedEntry>;
  history: HistoryEntry[];
  runsFired: number;
}

export const HISTORY_LIMIT = 100;

export function emptyState(): OrchestratorState {
  return {
    version: STATE_FILE_VERSION,
    mode: "paused",
    lastMergeSha: null,
    active: null,
    blocked: {},
    history: [],
    runsFired: 0,
  };
}

export interface StateStore {
  get(): OrchestratorState;
  update(mutator: (draft: OrchestratorState) => void): OrchestratorState;
  pushHistory(entry: Omit<HistoryEntry, "at"> & { at?: string }): void;
  flush(): void;
  path(): string;
}

export interface StateStoreOptions {
  dir: string;
  now?: () => Date;
  initial?: OrchestratorState;
}

export function createStateStore(opts: StateStoreOptions): StateStore {
  const stateFile = path.join(opts.dir, "state.json");
  const now = opts.now ?? (() => new Date());
  mkdirSync(opts.dir, { recursive: true });

  let state: OrchestratorState;
  if (opts.initial) {
    state = opts.initial;
  } else if (existsSync(stateFile)) {
    state = readStateFile(stateFile);
  } else {
    state = emptyState();
    writeAtomic(stateFile, state);
  }

  const writeState = (): void => {
    writeAtomic(stateFile, state);
  };

  return {
    get() {
      return clone(state);
    },
    update(mutator) {
      const draft = clone(state);
      mutator(draft);
      draft.history = trimHistory(draft.history);
      state = draft;
      writeState();
      return clone(state);
    },
    pushHistory(entry) {
      const at = entry.at ?? now().toISOString();
      const draft = clone(state);
      draft.history.push({ ...entry, at });
      draft.history = trimHistory(draft.history);
      state = draft;
      writeState();
    },
    flush() {
      writeState();
    },
    path() {
      return stateFile;
    },
  };
}

export function readStateFile(filePath: string): OrchestratorState {
  const text = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`orchestrator state file is not valid JSON: ${msg}`);
  }
  return migrateState(parsed, filePath);
}

function migrateState(parsed: unknown, filePath: string): OrchestratorState {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`orchestrator state at ${filePath} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== STATE_FILE_VERSION) {
    throw new Error(
      `orchestrator state version mismatch at ${filePath}: expected ${STATE_FILE_VERSION}, got ${JSON.stringify(version)}`,
    );
  }
  const fallback = emptyState();
  return {
    version: STATE_FILE_VERSION,
    mode: isRunMode(obj.mode) ? obj.mode : fallback.mode,
    lastMergeSha:
      typeof obj.lastMergeSha === "string" || obj.lastMergeSha === null
        ? (obj.lastMergeSha as string | null)
        : fallback.lastMergeSha,
    active: isActiveRun(obj.active) ? obj.active : null,
    blocked: isBlockedMap(obj.blocked) ? obj.blocked : {},
    history: Array.isArray(obj.history)
      ? (obj.history as HistoryEntry[]).filter(isHistoryEntry)
      : [],
    runsFired:
      typeof obj.runsFired === "number" && Number.isFinite(obj.runsFired)
        ? obj.runsFired
        : 0,
  };
}

function isRunMode(v: unknown): v is RunMode {
  return v === "paused" || v === "running" || v === "idle" || v === "stopping";
}

function isActiveRun(v: unknown): v is ActiveRun {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.planId === "string" &&
    typeof obj.branch === "string" &&
    typeof obj.startedAt === "string" &&
    typeof obj.logPath === "string" &&
    typeof obj.rateLimitRetries === "number"
  );
}

function isBlockedMap(v: unknown): v is Record<string, BlockedEntry> {
  if (!v || typeof v !== "object") return false;
  for (const entry of Object.values(v)) {
    if (!entry || typeof entry !== "object") return false;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.reason !== "string") return false;
    if (typeof obj.blockedAt !== "string") return false;
    if (typeof obj.retries !== "number") return false;
  }
  return true;
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    (typeof obj.planId === "string" || obj.planId === null) &&
    typeof obj.event === "string" &&
    typeof obj.at === "string"
  );
}

function trimHistory(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= HISTORY_LIMIT) return history;
  return history.slice(history.length - HISTORY_LIMIT);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Atomic write: serialize to a sibling temp file, fsync, rename into place,
// then fsync the parent directory so the rename itself is durable across a
// host crash. Rename on the same filesystem is atomic on POSIX — readers
// either see the prior file or the new file, never a partial write.
export function writeAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(tmp, payload, { encoding: "utf8" });
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  // Fsync the parent directory so the rename is persisted even if the host
  // crashes before the next dirent flush. Best-effort on platforms where
  // opening a directory for fsync is not permitted (Windows); the rename
  // itself is already atomic from a reader's perspective.
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Non-POSIX filesystems may refuse to open a directory for fsync.
    // The rename is still atomic; only crash durability is weaker.
  }
}
