import path from "node:path";

import { fileIdFromFilename } from "./loader.ts";
import type { GraphIssue, Plan, ValidationResult } from "./types.ts";

export function validateGraph(plans: Plan[]): ValidationResult {
  const issues: GraphIssue[] = [];

  const byId = new Map<string, Plan[]>();
  for (const plan of plans) {
    const group = byId.get(plan.id) ?? [];
    group.push(plan);
    byId.set(plan.id, group);
  }

  for (const [id, group] of byId) {
    if (group.length > 1) {
      issues.push({
        kind: "duplicate-id",
        id,
        files: group.map((p) => p.filePath).sort(),
      });
    }
  }

  for (const plan of plans) {
    const filename = path.basename(plan.filePath);
    const fileId = fileIdFromFilename(filename);
    if (fileId !== plan.id) {
      issues.push({
        kind: "id-filename-mismatch",
        id: plan.id,
        filePath: plan.filePath,
      });
    }

    if (plan.dependsOn.includes(plan.id)) {
      issues.push({
        kind: "self-dependency",
        id: plan.id,
        filePath: plan.filePath,
      });
    }

    for (const dep of plan.dependsOn) {
      if (!byId.has(dep)) {
        issues.push({
          kind: "missing-dependency",
          id: plan.id,
          missing: dep,
          filePath: plan.filePath,
        });
      }
    }

    const expectedLocation =
      plan.status === "completed" ? "completed" : "active";
    if (plan.location !== expectedLocation) {
      issues.push({
        kind: "status-location-mismatch",
        id: plan.id,
        status: plan.status,
        location: plan.location,
        filePath: plan.filePath,
      });
    }
  }

  const cyclePath = findCycle(plans);
  if (cyclePath) {
    issues.push({ kind: "cycle", path: cyclePath });
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

// Iterative DFS with coloring: 0 = unvisited, 1 = on stack, 2 = done.
// Returns the first cycle found as a sequence of ids (first == last) or null.
function findCycle(plans: Plan[]): string[] | null {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const color = new Map<string, 0 | 1 | 2>();
  for (const plan of plans) color.set(plan.id, 0);

  for (const start of [...byId.keys()].sort()) {
    if (color.get(start) !== 0) continue;
    const stack: Array<{ id: string; nextDep: number }> = [
      { id: start, nextDep: 0 },
    ];
    const pathIds: string[] = [start];
    color.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const plan = byId.get(frame.id);
      const deps = plan ? plan.dependsOn : [];
      if (frame.nextDep >= deps.length) {
        color.set(frame.id, 2);
        stack.pop();
        pathIds.pop();
        continue;
      }
      const dep = deps[frame.nextDep]!;
      frame.nextDep += 1;
      if (!byId.has(dep)) continue;
      const depColor = color.get(dep);
      if (depColor === 1) {
        const startIndex = pathIds.indexOf(dep);
        const cycle = pathIds.slice(startIndex).concat(dep);
        return cycle;
      }
      if (depColor === 0) {
        color.set(dep, 1);
        pathIds.push(dep);
        stack.push({ id: dep, nextDep: 0 });
      }
    }
  }
  return null;
}

export function formatIssue(issue: GraphIssue): string {
  switch (issue.kind) {
    case "duplicate-id":
      return `Duplicate plan id ${issue.id} in files: ${issue.files.join(", ")}`;
    case "missing-dependency":
      return `Plan ${issue.id} (${issue.filePath}) depends on unknown plan ${issue.missing}`;
    case "cycle":
      return `Dependency cycle detected: ${issue.path.join(" -> ")}`;
    case "id-filename-mismatch":
      return `Plan ${issue.id} frontmatter id does not match filename prefix at ${issue.filePath}`;
    case "status-location-mismatch":
      return `Plan ${issue.id} status '${issue.status}' disagrees with directory '${issue.location}' at ${issue.filePath}`;
    case "self-dependency":
      return `Plan ${issue.id} lists itself in depends_on at ${issue.filePath}`;
  }
}
