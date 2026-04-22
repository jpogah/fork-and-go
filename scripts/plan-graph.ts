// Entry point for the plan-graph CLI. Invoked via scripts/plan-graph.sh, which
// wraps `tsx` so we can import the TypeScript source of @fork-and-go/plan-graph
// directly. Output is intentionally mechanical — greppable, stable order,
// non-zero exit on any graph violation so preflight can gate on it.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildSnapshot,
  formatIssue,
  generatePlansMarkdown,
  loadPlans,
  nextEligiblePlans,
  planStatus,
  toDot,
  toMermaid,
  topologicalOrder,
  validateGraph,
} from "@fork-and-go/plan-graph";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ACTIVE_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "active");
const COMPLETED_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "completed");

function usage(): string {
  return [
    "Usage: plan-graph <command> [args]",
    "",
    "Commands:",
    "  next                     Print next eligible plans",
    "  validate                 Validate the plan graph; exit non-zero on error",
    "  status <id>              Print one plan's resolved state",
    "  graph [--dot|--mermaid]  Emit the dependency graph (default: mermaid)",
    "  generate-md              Print the regenerated PLANS.md to stdout",
    "  snapshot                 Print a JSON snapshot of the resolved graph",
  ].join("\n");
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const plans = loadPlans({
    activeDir: ACTIVE_DIR,
    completedDir: COMPLETED_DIR,
  });

  switch (command) {
    case "validate": {
      const result = validateGraph(plans);
      if (result.ok) {
        process.stdout.write(`Plan graph OK: ${plans.length} plans.\n`);
        return 0;
      }
      process.stderr.write("Plan graph FAILED validation:\n");
      for (const issue of result.issues) {
        process.stderr.write(`  - ${formatIssue(issue)}\n`);
      }
      return 1;
    }
    case "next": {
      const result = validateGraph(plans);
      if (!result.ok) {
        process.stderr.write(
          "Refusing to compute next eligible plans on a broken graph. Run `plan-graph validate` for details.\n",
        );
        return 1;
      }
      const eligible = nextEligiblePlans(plans);
      if (eligible.length === 0) {
        process.stdout.write("No eligible plans.\n");
        return 0;
      }
      for (const plan of eligible) {
        process.stdout.write(`${plan.id}\t${plan.phase}\t${plan.title}\n`);
      }
      return 0;
    }
    case "status": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("status requires a plan id (e.g. 0048)\n");
        return 2;
      }
      const report = planStatus(plans, id);
      if (!report) {
        process.stderr.write(`Unknown plan id: ${id}\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    case "graph": {
      const format = rest.includes("--dot") ? "dot" : "mermaid";
      process.stdout.write(format === "dot" ? toDot(plans) : toMermaid(plans));
      return 0;
    }
    case "topological": {
      const ordered = topologicalOrder(plans);
      for (const plan of ordered) {
        process.stdout.write(`${plan.id}\t${plan.title}\n`);
      }
      return 0;
    }
    case "generate-md": {
      const result = validateGraph(plans);
      if (!result.ok) {
        process.stderr.write(
          "Refusing to regenerate PLANS.md on a broken graph. Run `plan-graph validate` for details.\n",
        );
        return 1;
      }
      process.stdout.write(generatePlansMarkdown(plans, REPO_ROOT));
      return 0;
    }
    case "snapshot": {
      const snapshot = buildSnapshot(plans);
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
      return 0;
    }
    default: {
      process.stderr.write(`Unknown command: ${command}\n${usage()}\n`);
      return 2;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `plan-graph: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  });
