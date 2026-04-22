import { topologicalOrder } from "./resolver.ts";
import type { Plan } from "./types.ts";

export function toMermaid(plans: Plan[]): string {
  const lines: string[] = ["graph TD"];
  const ordered = [...plans].sort((a, b) => a.id.localeCompare(b.id));
  for (const plan of ordered) {
    const label = `${plan.id} ${escapeMermaidLabel(plan.title)}`;
    const style = plan.status === "completed" ? ":::completed" : "";
    lines.push(`  ${plan.id}["${label}"]${style}`);
  }
  for (const plan of ordered) {
    for (const dep of [...plan.dependsOn].sort()) {
      lines.push(`  ${dep} --> ${plan.id}`);
    }
  }
  lines.push("  classDef completed fill:#d4edda,stroke:#155724");
  return lines.join("\n") + "\n";
}

export function toDot(plans: Plan[]): string {
  const lines: string[] = ["digraph plans {", "  rankdir=LR;"];
  const ordered = [...plans].sort((a, b) => a.id.localeCompare(b.id));
  for (const plan of ordered) {
    const fill = plan.status === "completed" ? "#d4edda" : "#ffffff";
    lines.push(
      `  "${plan.id}" [label="${plan.id}\\n${escapeDot(plan.title)}", shape=box, style=filled, fillcolor="${fill}"];`,
    );
  }
  for (const plan of ordered) {
    for (const dep of [...plan.dependsOn].sort()) {
      lines.push(`  "${dep}" -> "${plan.id}";`);
    }
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function escapeMermaidLabel(value: string): string {
  return value.replaceAll(`"`, `'`);
}

function escapeDot(value: string): string {
  return value.replaceAll(`"`, `\\"`);
}

// Stable snapshot of the resolved graph for reviewer convenience / diffs.
export interface GraphSnapshot {
  generatedFrom: "packages/plan-graph";
  plans: Array<{
    id: string;
    title: string;
    phase: string;
    status: Plan["status"];
    location: Plan["location"];
    dependsOn: string[];
    blocks: string[];
  }>;
  eligible: string[];
  topologicalOrder: string[];
}

export function buildSnapshot(plans: Plan[]): GraphSnapshot {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const blocks = new Map<string, string[]>();
  for (const plan of plans) blocks.set(plan.id, []);
  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      const list = blocks.get(dep);
      if (list) list.push(plan.id);
    }
  }
  for (const list of blocks.values()) list.sort();

  const ordered = topologicalOrder(plans);
  const eligible = plans
    .filter(
      (p) =>
        p.status === "active" &&
        p.dependsOn.every((d) => (byId.get(d)?.status ?? null) === "completed"),
    )
    .map((p) => p.id)
    .sort();

  return {
    generatedFrom: "packages/plan-graph",
    plans: [...plans]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        title: p.title,
        phase: p.phase,
        status: p.status,
        location: p.location,
        dependsOn: [...p.dependsOn],
        blocks: blocks.get(p.id) ?? [],
      })),
    eligible,
    topologicalOrder: ordered.map((p) => p.id),
  };
}
