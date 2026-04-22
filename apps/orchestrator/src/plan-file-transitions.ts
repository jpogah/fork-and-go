// Moves a plan file from docs/exec-plans/active/ to docs/exec-plans/completed/
// and flips its YAML frontmatter `status` from active to completed. The
// plan-graph validator requires the directory and the status to agree, so
// we must update both in one shot.
//
// Lives in the orchestrator (not @fork-and-go/plan-graph) because the
// orchestrator is the only caller that needs it today; promote to the
// shared package once a second caller emerges.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { loadPlanFile, splitFrontmatter, type Plan } from "@fork-and-go/plan-graph";
import YAML from "yaml";

export interface PlanDirs {
  activeDir: string;
  completedDir: string;
}

export interface MigrationResult {
  planId: string;
  from: string;
  to: string;
}

export function markPlanCompleted(
  planId: string,
  dirs: PlanDirs,
): MigrationResult {
  const src = findPlanFile(dirs.activeDir, planId);
  if (!src) {
    // Idempotency: if the file is already in completedDir with
    // status: completed, treat this as a no-op success. A prior successful
    // migration (e.g., via a PR that moved the file, or an earlier
    // orchestrator run that crashed right after the rename) should not flip
    // the plan to `blocked` on a later re-run.
    const alreadyMigrated = findCompletedPlanFile(dirs.completedDir, planId);
    if (alreadyMigrated) {
      return { planId, from: alreadyMigrated, to: alreadyMigrated };
    }
    throw new Error(
      `Cannot mark ${planId} completed: no matching file in ${dirs.activeDir}`,
    );
  }
  const plan = loadPlanFile(src, "active");
  const rewritten = rewriteFrontmatterStatus(plan, "completed");
  mkdirSync(dirs.completedDir, { recursive: true });
  const destName = path.basename(src);
  const dest = path.join(dirs.completedDir, destName);
  if (existsSync(dest)) {
    throw new Error(
      `Cannot mark ${planId} completed: destination already exists at ${dest}`,
    );
  }
  // Crash-safe migration: write the rewritten content to a temp file under
  // completedDir, fsync, rename onto the destination, then unlink src. The
  // source file is never mutated in place — so a crash before the rename
  // leaves only an orphan temp file (cleanable), and a crash between rename
  // and unlink leaves both files intact (the duplicate-id is caught by
  // validateGraph and the operator removes src). The previous "writeFile
  // src; rename src dest" sequence could leave src with status=completed
  // sitting in active/, which validateGraph rejects and bricks startup.
  const tmpDest = path.join(
    dirs.completedDir,
    `.${destName}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpDest, rewritten, "utf8");
  const fd = openSync(tmpDest, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpDest, dest);
  unlinkSync(src);
  return { planId, from: src, to: dest };
}

export function findPlanFile(activeDir: string, planId: string): string | null {
  if (!existsSync(activeDir)) return null;
  const entries = readdirSync(activeDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith(`${planId}-`)) continue;
    return path.join(activeDir, entry.name);
  }
  return null;
}

function findCompletedPlanFile(
  completedDir: string,
  planId: string,
): string | null {
  if (!existsSync(completedDir)) return null;
  const entries = readdirSync(completedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith(`${planId}-`)) continue;
    return path.join(completedDir, entry.name);
  }
  return null;
}

// Preserves everything in the file except the `status:` line in the YAML
// frontmatter. Using YAML.stringify would reorder keys, strip comments, and
// reflow the document — too destructive for a checked-in plan. A line-level
// rewrite is safer.
export function rewriteFrontmatterStatus(
  plan: Plan,
  newStatus: "active" | "in_progress" | "completed" | "blocked",
): string {
  const raw = readFileSync(plan.filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(plan.filePath, raw);

  const updatedFrontmatter = rewriteStatusLine(frontmatter, newStatus);
  const parsed = YAML.parse(updatedFrontmatter) as Record<string, unknown>;
  if (parsed.status !== newStatus) {
    throw new Error(
      `rewriteFrontmatterStatus: post-rewrite status did not apply for ${plan.id}`,
    );
  }
  return `---\n${updatedFrontmatter}\n---\n${body}`;
}

function rewriteStatusLine(frontmatter: string, newStatus: string): string {
  const lines = frontmatter.split("\n");
  let found = false;
  const rewritten = lines.map((line) => {
    const match = /^(status:\s*)(.*)$/.exec(line);
    if (!match) return line;
    found = true;
    return `${match[1]}"${newStatus}"`;
  });
  if (!found) {
    throw new Error(
      "rewriteFrontmatterStatus: no `status:` line in frontmatter",
    );
  }
  return rewritten.join("\n");
}
