import type { Plan, PlanStatusReport } from "./types.ts";

export function planIndex(plans: Plan[]): Map<string, Plan> {
  return new Map(plans.map((p) => [p.id, p]));
}

export function computeBlocks(plans: Plan[]): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const plan of plans) blocks.set(plan.id, []);
  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      const list = blocks.get(dep);
      if (list) list.push(plan.id);
    }
  }
  for (const list of blocks.values()) list.sort();
  return blocks;
}

export function unmetDependencies(plan: Plan, plans: Plan[]): string[] {
  const byId = planIndex(plans);
  const unmet: string[] = [];
  for (const dep of plan.dependsOn) {
    const depPlan = byId.get(dep);
    if (!depPlan || depPlan.status !== "completed") unmet.push(dep);
  }
  return unmet;
}

export function nextEligiblePlans(plans: Plan[]): Plan[] {
  return plans
    .filter((p) => p.status === "active")
    .filter((p) => unmetDependencies(p, plans).length === 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function planStatus(plans: Plan[], id: string): PlanStatusReport | null {
  const plan = planIndex(plans).get(id);
  if (!plan) return null;
  const blocks = computeBlocks(plans).get(plan.id) ?? [];
  const unmet = unmetDependencies(plan, plans);
  return {
    id: plan.id,
    title: plan.title,
    phase: plan.phase,
    status: plan.status,
    dependsOn: [...plan.dependsOn],
    blocks,
    eligible: plan.status === "active" && unmet.length === 0,
    unmetDependencies: unmet,
    location: plan.location,
    filePath: plan.filePath,
    estimatedPasses: plan.estimatedPasses,
    acceptanceTags: [...plan.acceptanceTags],
  };
}

// Kahn's algorithm with stable tie-breaking by id ascending. Plans with
// dependencies on ids outside the graph (already caught by validator) are
// treated as roots for ordering purposes.
export function topologicalOrder(plans: Plan[]): Plan[] {
  const byId = planIndex(plans);
  const indegree = new Map<string, number>();
  for (const plan of plans) {
    let count = 0;
    for (const dep of plan.dependsOn) if (byId.has(dep)) count += 1;
    indegree.set(plan.id, count);
  }

  const ready: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) ready.push(id);
  }
  ready.sort();

  const out: Plan[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const plan = byId.get(id)!;
    out.push(plan);
    for (const other of plans) {
      if (!other.dependsOn.includes(id)) continue;
      const remaining = (indegree.get(other.id) ?? 0) - 1;
      indegree.set(other.id, remaining);
      if (remaining === 0) {
        insertSorted(ready, other.id);
      }
    }
  }
  return out;
}

function insertSorted(list: string[], value: string): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? "") < value) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, value);
}
