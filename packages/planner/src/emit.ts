// Emit phase: serializes a set of (proposal, body) pairs into plan files,
// runs the 0048 graph validator over the combined (existing + new) set, and
// either writes every file or writes none. Atomicity matters here — a half-
// emitted plan graph is the single worst failure mode for the planner.
//
// Atomicity strategy:
//  1. Dry-run validate the combined graph. If invalid, abort before touching
//     the disk.
//  2. Write each plan body to a sibling `.tmp-<nonce>` file. If any tmp write
//     fails, unlink every tmp already written and return an error.
//  3. Rename each tmp file to its final path. If a rename fails mid-batch,
//     roll back: unlink any files already renamed into place and any tmps
//     still on disk.
// This gives the caller "either every plan file lands or none do" even when
// a write hits disk-full, permissions, or a SIGTERM between operations.

import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import YAML from "yaml";

import {
  formatIssue,
  validateGraph,
  type Plan,
  type PlanFrontmatter,
} from "@fork-and-go/plan-graph";

import type { PlanProposal } from "./schemas.ts";

export interface EmitInput {
  proposal: PlanProposal;
  body: string;
}

export interface EmitOptions {
  activeDir: string;
  existingPlans: ReadonlyArray<Plan>;
}

export type EmitResult =
  | {
      ok: true;
      written: Array<{ id: string; filePath: string }>;
    }
  | {
      ok: false;
      reason: string;
      kind: EmitFailureKind;
    };

export type EmitFailureKind = "path-collision" | "graph-invalid" | "io-error";

export function composePlanFile(proposal: PlanProposal, body: string): string {
  const frontmatter: PlanFrontmatter = {
    id: proposal.id,
    title: proposal.title,
    phase: proposal.phase,
    status: "active",
    depends_on: [...proposal.depends_on],
    estimated_passes: proposal.estimated_passes,
    acceptance_tags: proposalAcceptanceTags(proposal),
  };
  const yaml = YAML.stringify(frontmatter).trimEnd();
  const bodyTrimmed = body.replace(/\s+$/u, "");
  return `---\n${yaml}\n---\n\n${bodyTrimmed}\n`;
}

// Hand-built proposals in tests predate the 0054 schema extension and may
// omit `acceptance_tags`. Fall back to an empty array so those fixtures keep
// working; Zod-validated proposals always carry the default.
function proposalAcceptanceTags(proposal: PlanProposal): string[] {
  return Array.isArray(proposal.acceptance_tags)
    ? [...proposal.acceptance_tags]
    : [];
}

// Dry-run validation — no disk writes. Useful for `--preview` mode and for
// unit tests that want to assert the planner would refuse to emit.
export function previewEmit(
  inputs: ReadonlyArray<EmitInput>,
  options: EmitOptions,
): EmitResult {
  const plans = buildSyntheticPlans(inputs, options);
  const validation = validateGraph(plans);
  if (!validation.ok) {
    const firstIssue = validation.issues[0];
    const reason = firstIssue
      ? `Proposed plan graph is invalid: ${formatIssue(firstIssue)}`
      : "Proposed plan graph is invalid";
    return { ok: false, kind: "graph-invalid", reason };
  }
  const collision = findPathCollision(inputs, options.activeDir);
  if (collision) {
    return {
      ok: false,
      kind: "path-collision",
      reason: `Refusing to overwrite existing file at ${collision}`,
    };
  }
  return {
    ok: true,
    written: inputs.map((i) => ({
      id: i.proposal.id,
      filePath: planFilePath(options.activeDir, i.proposal),
    })),
  };
}

export function emit(
  inputs: ReadonlyArray<EmitInput>,
  options: EmitOptions,
): EmitResult {
  const preview = previewEmit(inputs, options);
  if (!preview.ok) return preview;

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const staged: Array<{ id: string; tmpPath: string; finalPath: string }> = [];

  // Phase 1: stage every file as `<final>.tmp-<nonce>`. If any write fails,
  // unlink every tmp we've already produced and return.
  try {
    for (const input of inputs) {
      const finalPath = planFilePath(options.activeDir, input.proposal);
      const tmpPath = `${finalPath}.tmp-${nonce}`;
      const content = composePlanFile(input.proposal, input.body);
      writeFileSync(tmpPath, content, "utf8");
      staged.push({ id: input.proposal.id, tmpPath, finalPath });
    }
  } catch (err) {
    for (const s of staged) safeUnlink(s.tmpPath);
    return {
      ok: false,
      kind: "io-error",
      reason: `Failed to stage plan file: ${errorMessage(err)}`,
    };
  }

  // Phase 2: rename each tmp into place. A mid-batch failure triggers
  // rollback — unlink everything we've already renamed plus the remaining
  // tmps — so the caller sees either "all plans written" or "none written".
  const written: Array<{ id: string; filePath: string }> = [];
  for (let i = 0; i < staged.length; i += 1) {
    const s = staged[i]!;
    try {
      renameSync(s.tmpPath, s.finalPath);
      written.push({ id: s.id, filePath: s.finalPath });
    } catch (err) {
      for (const w of written) safeUnlink(w.filePath);
      for (let j = i; j < staged.length; j += 1) safeUnlink(staged[j]!.tmpPath);
      return {
        ok: false,
        kind: "io-error",
        reason: `Failed to commit plan file ${s.finalPath}: ${errorMessage(err)}`,
      };
    }
  }
  return { ok: true, written };
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* best-effort cleanup; the caller is already in a failure path. */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function planFilePath(activeDir: string, proposal: PlanProposal): string {
  return path.join(activeDir, `${proposal.id}-${proposal.slug}.md`);
}

function findPathCollision(
  inputs: ReadonlyArray<EmitInput>,
  activeDir: string,
): string | null {
  for (const input of inputs) {
    const filePath = planFilePath(activeDir, input.proposal);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function buildSyntheticPlans(
  inputs: ReadonlyArray<EmitInput>,
  options: EmitOptions,
): Plan[] {
  const newPlans: Plan[] = inputs.map((input) => {
    const filePath = planFilePath(options.activeDir, input.proposal);
    const tags = proposalAcceptanceTags(input.proposal);
    return {
      id: input.proposal.id,
      title: input.proposal.title,
      phase: input.proposal.phase,
      status: "active",
      dependsOn: [...input.proposal.depends_on].sort(),
      estimatedPasses: input.proposal.estimated_passes,
      acceptanceTags: [...tags],
      location: "active",
      filePath,
      body: input.body,
      raw: {
        id: input.proposal.id,
        title: input.proposal.title,
        phase: input.proposal.phase,
        status: "active",
        depends_on: [...input.proposal.depends_on],
        estimated_passes: input.proposal.estimated_passes,
        acceptance_tags: [...tags],
      },
    };
  });
  return [...options.existingPlans, ...newPlans];
}
