// File-based freeze sentinel. Presence of `.orchestrator/FROZEN` halts all
// runs cleanly — the orchestrator pauses before starting the next plan, and
// `run_task.sh` refuses to start when launched directly. The file-based shape
// survives orchestrator restart, and operators can inspect / `rm` it without
// tooling.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const FREEZE_FILENAME = "FROZEN";

export function freezePath(dir: string): string {
  return path.join(dir, FREEZE_FILENAME);
}

export function isFrozen(dir: string): boolean {
  return existsSync(freezePath(dir));
}

export interface FreezeNote {
  // Free-form note written into the FROZEN file. Shown to the operator when
  // `run_task.sh` refuses to start; also visible via `cat .orchestrator/FROZEN`.
  reason?: string;
  at?: string;
}

export function freeze(dir: string, note: FreezeNote = {}): void {
  mkdirSync(dir, { recursive: true });
  const body = {
    frozenAt: note.at ?? new Date().toISOString(),
    reason: note.reason ?? "frozen by operator",
  };
  writeFileSync(freezePath(dir), JSON.stringify(body, null, 2) + "\n", "utf8");
}

export function unfreeze(dir: string): void {
  const file = freezePath(dir);
  if (existsSync(file)) rmSync(file, { force: true });
}

export function readFreezeNote(dir: string): FreezeNote | null {
  const file = freezePath(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
        ...(typeof obj.frozenAt === "string" ? { at: obj.frozenAt } : {}),
      };
    }
  } catch {
    // Non-JSON body is acceptable — older/hand-written freeze files may be
    // plain text. Return an empty note so callers still see "frozen".
  }
  return {};
}
