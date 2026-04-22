// Plan-file status writer. Edits only the `status:` line inside the YAML
// frontmatter; the body and the rest of the frontmatter are preserved byte
// for byte. We intentionally do not re-serialize the YAML: YAML.parse ->
// YAML.stringify changes quoting, ordering, and trailing whitespace, which
// turns the status flip into a noisy diff and risks subtle schema drift.

import { readFileSync, writeFileSync } from "node:fs";

import { PLAN_STATUSES, type PlanStatus } from "./schema.ts";
import { splitFrontmatter } from "./loader.ts";

export interface SetPlanStatusResult {
  filePath: string;
  previousStatus: PlanStatus;
  newStatus: PlanStatus;
  changed: boolean;
}

export function setPlanStatus(
  filePath: string,
  newStatus: PlanStatus,
): SetPlanStatusResult {
  if (!PLAN_STATUSES.includes(newStatus)) {
    throw new Error(
      `setPlanStatus: '${newStatus}' is not one of ${PLAN_STATUSES.join(", ")}`,
    );
  }
  const original = readFileSync(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(filePath, original);

  const { previousStatus, updatedFrontmatter } = replaceStatusLine(
    frontmatter,
    filePath,
    newStatus,
  );

  if (previousStatus === newStatus) {
    return { filePath, previousStatus, newStatus, changed: false };
  }

  const rebuilt = `---\n${updatedFrontmatter}\n---\n${body}`;
  writeFileSync(filePath, rebuilt, "utf8");
  return { filePath, previousStatus, newStatus, changed: true };
}

function replaceStatusLine(
  frontmatter: string,
  filePath: string,
  newStatus: PlanStatus,
): { previousStatus: PlanStatus; updatedFrontmatter: string } {
  const lines = frontmatter.split("\n");
  let foundIndex = -1;
  let previous: PlanStatus | null = null;
  // Match `status:` at column 0 — nested `status:` entries in the schema
  // aren't valid, so anchoring to column 0 avoids false positives inside
  // any future multi-line values.
  const statusRegex = /^status:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*$/u;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = statusRegex.exec(line);
    if (!match) continue;
    foundIndex = i;
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!(PLAN_STATUSES as ReadonlyArray<string>).includes(value)) {
      throw new Error(
        `${filePath}: existing status '${value}' is not one of ${PLAN_STATUSES.join(", ")}`,
      );
    }
    previous = value as PlanStatus;
    break;
  }
  if (foundIndex === -1 || previous === null) {
    throw new Error(`${filePath}: no 'status:' line found in frontmatter`);
  }
  lines[foundIndex] = `status: "${newStatus}"`;
  return {
    previousStatus: previous,
    updatedFrontmatter: lines.join("\n"),
  };
}
