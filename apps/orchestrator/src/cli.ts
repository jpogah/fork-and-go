// `harness` CLI — single binary for everything the harness exposes to a
// target repo. Resolves the target repo from --repo, HARNESS_TARGET_REPO,
// or process.cwd(); loads harness.config.{json,ts}; dispatches.
//
// Subcommands:
//   harness init [--provider <claude|codex>] [--force]
//   harness run <task-id-or-plan-path> [--phase ...] [--local-only] [--skip-e2e] [--dry-run]
//   harness daemon start
//   harness daemon stop | freeze | unfreeze | status
//   harness fidelity --spec <path>
//   harness plan <spec-file> [--preview] [--max-new-plans N]

import { existsSync } from "node:fs";
import path from "node:path";

import {
  loadHarnessConfig,
  resolveRepoRoot,
  type HarnessConfig,
} from "@harness/config";
import {
  createAgentRunner,
  wrapAgentAsCompletionClient,
} from "@harness/agent-runner";

import { runTask, type Phase } from "./runner/index.ts";

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = args[0] ?? "help";
  let subcommand: string | undefined;
  let i = 1;
  // Some commands take a subcommand (e.g., `daemon start`); detect by the
  // shape of args[1].
  if (
    command === "daemon" &&
    args[1] &&
    !args[1].startsWith("-")
  ) {
    subcommand = args[1];
    i = 2;
  }
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        i += 1;
        continue;
      }
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
      continue;
    }
    positional.push(arg);
    i += 1;
  }
  return { command, ...(subcommand ? { subcommand } : {}), positional, flags };
}

function usage(): string {
  return [
    "harness — repo-agnostic agent harness driven by Claude Agent SDK and Codex SDK.",
    "",
    "Usage:",
    "  harness init [--provider claude|codex] [--force]",
    "  harness run <task-id-or-plan-path> [options]",
    "  harness daemon <start|stop|freeze|unfreeze|status> [options]",
    "  harness plan <spec-file> [--preview] [--max-new-plans N]",
    "  harness fidelity --spec <path>",
    "",
    "Options (all commands):",
    "  --repo <path>      Target repo to operate on. Defaults to HARNESS_TARGET_REPO",
    "                     env var, then process.cwd().",
    "",
    "run-specific:",
    "  --phase <name>     all | implement | review | review-ui | fix |",
    "                     prepare-pr | e2e-verify | merge-check (default: all)",
    "  --local-only       Skip push, PR, and merge operations.",
    "  --skip-e2e         Skip the e2e-verify gate (use only for non-UI plans).",
    "  --dry-run          Log actions without invoking the agent or git.",
    "  --resume           Re-enter the review/fix loop on the existing branch.",
    "",
    "Each target repo must commit a harness.config.{json,ts} at its root with at",
    "least an `agent.provider` (claude | codex). See @harness/config for the full schema.",
  ].join("\n");
}

async function loadConfigOrDie(repoRoot: string): Promise<HarnessConfig> {
  try {
    return await loadHarnessConfig(repoRoot, { env: process.env });
  } catch (err) {
    process.stderr.write(
      `harness: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

function repoRootFromFlags(flags: Record<string, string | boolean>): string {
  const fromFlag = typeof flags.repo === "string" ? flags.repo : null;
  const repoRoot = fromFlag
    ? path.resolve(fromFlag)
    : resolveRepoRoot(process.env);
  if (!existsSync(repoRoot)) {
    process.stderr.write(`harness: target repo not found: ${repoRoot}\n`);
    process.exit(2);
  }
  return repoRoot;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const taskRef = args.positional[0];
  if (!taskRef) {
    process.stderr.write("harness run: missing <task-id-or-plan-path>\n");
    process.stderr.write(usage() + "\n");
    return 2;
  }
  const repoRoot = repoRootFromFlags(args.flags);
  const config = await loadConfigOrDie(repoRoot);

  const phase = (typeof args.flags.phase === "string" ? args.flags.phase : "all") as Phase;
  const validPhases: ReadonlyArray<Phase> = [
    "all",
    "implement",
    "review",
    "review-ui",
    "fix",
    "prepare-pr",
    "e2e-verify",
    "merge-check",
  ];
  if (!validPhases.includes(phase)) {
    process.stderr.write(`harness run: unknown --phase ${phase}\n`);
    return 2;
  }

  const outcome = await runTask({
    taskRef,
    repoRoot,
    config,
    phase,
    localOnly: args.flags["local-only"] === true,
    skipE2e: args.flags["skip-e2e"] === true,
    dryRun: args.flags["dry-run"] === true,
    resume: args.flags.resume === true,
    logger: (line) => process.stderr.write(line + "\n"),
  });

  if (outcome.ok) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          planId: outcome.planId,
          branch: outcome.branch,
          phasesRun: outcome.phasesRun,
          tokensTotal: outcome.tokensTotal,
          logPath: outcome.logPath,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stderr.write(
    JSON.stringify(
      {
        ok: false,
        planId: outcome.planId,
        branch: outcome.branch,
        rateLimited: outcome.rateLimited ?? false,
        reason: outcome.reason,
        logPath: outcome.logPath,
      },
      null,
      2,
    ) + "\n",
  );
  return outcome.rateLimited ? 2 : 1;
}

async function cmdDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.subcommand ?? "status";
  switch (sub) {
    case "start": {
      // Boot the daemon in-process. We import the daemon entry lazily so
      // `harness run` doesn't pull in the full daemon graph.
      const { default: startDaemon } = await import("./daemon-bootstrap.ts");
      const repoRoot = repoRootFromFlags(args.flags);
      const config = await loadConfigOrDie(repoRoot);
      await startDaemon({ repoRoot, config });
      return 0;
    }
    case "stop":
    case "freeze":
    case "unfreeze":
    case "status": {
      const port = process.env.ORCHESTRATOR_PORT ?? "4500";
      const path =
        sub === "status" ? "/state" : sub === "stop" ? "/stop" : `/${sub}`;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: sub === "status" ? "GET" : "POST",
        });
        process.stdout.write((await response.text()) + "\n");
        return response.ok ? 0 : 1;
      } catch (err) {
        process.stderr.write(
          `harness daemon ${sub}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    default:
      process.stderr.write(`harness daemon: unknown subcommand ${sub}\n`);
      return 2;
  }
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  const fs = await import("node:fs");
  const repoRoot = repoRootFromFlags(args.flags);
  const provider =
    args.flags.provider === "codex" || args.flags.provider === "claude"
      ? args.flags.provider
      : "claude";
  const force = args.flags.force === true;

  const configPath = path.join(repoRoot, "harness.config.json");
  if (fs.existsSync(configPath) && !force) {
    process.stderr.write(
      `harness init: harness.config.json already exists at ${configPath}. Pass --force to overwrite.\n`,
    );
    return 1;
  }

  const config = {
    agent: { provider, maxReviewPasses: 5 },
    appPaths: ["src"],
    baseBranch: "main",
    devServer: {
      command: "npm run dev",
      url: "http://localhost:3000",
    },
    e2e: {
      command: "npm run e2e",
      artifactDirs: ["playwright-report", "test-results"],
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${path.relative(repoRoot, configPath)}\n`);

  // Sample plan dir + plan file.
  const planDir = path.join(repoRoot, "docs", "exec-plans", "active");
  const completedDir = path.join(repoRoot, "docs", "exec-plans", "completed");
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(completedDir, { recursive: true });
  // .gitkeep so the empty completed/ dir survives a git commit.
  const gitkeep = path.join(completedDir, ".gitkeep");
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, "", "utf8");

  const samplePlanPath = path.join(planDir, "0001-example.md");
  if (!fs.existsSync(samplePlanPath) || force) {
    const samplePlan = [
      "---",
      'id: "0001"',
      'title: "Example plan"',
      'phase: "Harness"',
      'status: "active"',
      "depends_on: []",
      "estimated_passes: 1",
      "acceptance_tags: []",
      "---",
      "",
      "# 0001 Example plan",
      "",
      "## Goal",
      "",
      "Replace this with a one-paragraph statement of what should be true",
      "after the plan ships. The agent reads this as the source of truth.",
      "",
      "## Why Now",
      "",
      "Why this plan, why now. Keep it short.",
      "",
      "## Scope",
      "",
      "- Bullet the work that's in scope.",
      "- One bullet per concern.",
      "",
      "## Out Of Scope",
      "",
      "- Bullet the things explicitly not in this plan.",
      "",
      "## Implement",
      "",
      "Step-by-step instructions for the implementer agent. Be concrete.",
      "",
      "## Validation",
      "",
      "- How a human (or the review agent) confirms this shipped correctly.",
      "",
      "## Open Questions",
      "",
      "- (none)",
      "",
      "## Decision Log",
      "",
      "- (none)",
      "",
    ].join("\n");
    fs.writeFileSync(samplePlanPath, samplePlan, "utf8");
    process.stdout.write(
      `wrote ${path.relative(repoRoot, samplePlanPath)}\n`,
    );
  }

  process.stdout.write(
    "\nNext steps:\n" +
      "  1. Edit harness.config.json — at minimum, confirm appPaths, devServer, and e2e match your repo.\n" +
      "  2. Edit docs/exec-plans/active/0001-example.md to describe a real first plan.\n" +
      "  3. Commit both files.\n" +
      "  4. From the harness repo: HARNESS_TARGET_REPO=<this-repo> npm run harness -- run 0001 --phase implement --local-only\n",
  );
  return 0;
}

async function cmdPlan(args: ParsedArgs): Promise<number> {
  const specPath = args.positional[0];
  if (!specPath) {
    process.stderr.write("harness plan: missing <spec-file>\n");
    return 2;
  }
  const repoRoot = repoRootFromFlags(args.flags);
  const config = await loadConfigOrDie(repoRoot);

  // Lazy import — keeps `harness run` from pulling planner + release-gate.
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { runPlanner, createLoggerPlannerAuditSink, DEFAULT_MAX_NEW_PLANS } =
    await import("@harness/planner");
  const { parseAcceptanceFile } = await import("@harness/release-gate");

  const runner = createAgentRunner({
    provider: config.modelClient.provider ?? config.agent.provider,
    ...(config.modelClient.model
      ? { model: config.modelClient.model }
      : config.agent.model
        ? { model: config.agent.model }
        : {}),
  });
  const modelClient = wrapAgentAsCompletionClient(runner, { cwd: repoRoot });

  const specAbs = path.isAbsolute(specPath)
    ? specPath
    : path.resolve(repoRoot, specPath);

  // Optional sibling acceptance file.
  const dir = path.dirname(specAbs);
  const baseNoExt = path.basename(specAbs, path.extname(specAbs));
  const acceptanceCandidate = baseNoExt.endsWith(".acceptance")
    ? null
    : path.join(dir, `${baseNoExt}.acceptance.md`);
  const acceptanceTags =
    acceptanceCandidate && fs.existsSync(acceptanceCandidate)
      ? parseAcceptanceFile(acceptanceCandidate).criteria.map((c) => ({
          tag: c.tag,
          description: c.description,
        }))
      : [];

  const auditSink = createLoggerPlannerAuditSink({
    logger: (line) => process.stderr.write(line + "\n"),
  });

  const maxNewPlans =
    typeof args.flags["max-new-plans"] === "string"
      ? Number(args.flags["max-new-plans"])
      : DEFAULT_MAX_NEW_PLANS;

  const outcome = await runPlanner(
    {
      specPath: specAbs,
      activeDir: path.join(repoRoot, config.planDir),
      completedDir: path.join(repoRoot, config.completedDir),
      ...(config.contextDir
        ? { contextDir: path.join(repoRoot, config.contextDir) }
        : {}),
      repoRoot,
      mode: args.flags.preview === true ? "preview" : "emit",
      maxNewPlans,
      ...(acceptanceTags.length > 0 ? { acceptanceTags } : {}),
    },
    {
      modelClient,
      auditSink,
      ...(config.modelClient.model
        ? { defaultModel: config.modelClient.model }
        : {}),
    },
  );

  if (!outcome.ok) {
    process.stderr.write(
      `harness plan: FAILED at ${outcome.stage} — ${outcome.reason}\n`,
    );
    return 1;
  }
  if (outcome.result.mode === "preview") {
    process.stdout.write("Preview — proposals (no files written):\n");
    for (const proposal of outcome.result.proposals) {
      process.stdout.write(
        `  ${proposal.id}\t${proposal.phase}\t${proposal.title}\n`,
      );
    }
    return 0;
  }
  for (const written of outcome.result.emitted) {
    process.stdout.write(`wrote ${written.filePath}\n`);
  }
  return 0;
}

async function cmdFidelity(args: ParsedArgs): Promise<number> {
  const repoRoot = repoRootFromFlags(args.flags);
  const config = await loadConfigOrDie(repoRoot);
  const specFromFlag =
    typeof args.flags.spec === "string" ? args.flags.spec : null;
  const specRel = specFromFlag ?? config.fidelity?.specPath;
  if (!specRel) {
    process.stderr.write(
      "harness fidelity: pass --spec <path> or set fidelity.specPath in harness.config\n",
    );
    return 2;
  }

  const path = await import("node:path");
  const fs = await import("node:fs");
  const { runFidelityCheck, DEFAULT_THRESHOLD } = await import(
    "@harness/fidelity-check"
  );

  const specAbs = path.isAbsolute(specRel)
    ? specRel
    : path.resolve(repoRoot, specRel);
  if (!fs.existsSync(specAbs)) {
    process.stderr.write(`harness fidelity: spec not found at ${specAbs}\n`);
    return 2;
  }

  const runner = createAgentRunner({
    provider: config.modelClient.provider ?? config.agent.provider,
    ...(config.modelClient.model
      ? { model: config.modelClient.model }
      : config.agent.model
        ? { model: config.agent.model }
        : {}),
  });
  const modelClient = wrapAgentAsCompletionClient(runner, { cwd: repoRoot });

  const outcome = await runFidelityCheck(
    {
      specPath: specAbs,
      activeDir: path.join(repoRoot, config.planDir),
      completedDir: path.join(repoRoot, config.completedDir),
      reportsDir: path.join(repoRoot, config.stateDir, "fidelity-reports"),
      repoRoot,
      appPaths: config.appPaths,
      threshold:
        typeof args.flags.threshold === "string"
          ? Number(args.flags.threshold)
          : DEFAULT_THRESHOLD,
      autoSuspend: args.flags["auto-suspend"] !== false,
    },
    { modelClient },
  );

  if (!outcome.ok) {
    process.stderr.write(
      `harness fidelity: FAILED at ${outcome.stage} — ${outcome.reason}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `drift score ${outcome.score}/100 (threshold ${outcome.threshold})\n`,
  );
  process.stdout.write(`wrote ${outcome.report.markdownPath}\n`);
  return outcome.exceedsThreshold ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "init":
      return await cmdInit(args);
    case "run":
      return await cmdRun(args);
    case "daemon":
      return await cmdDaemon(args);
    case "plan":
      return await cmdPlan(args);
    case "fidelity":
      return await cmdFidelity(args);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      process.stdout.write(usage() + "\n");
      return 0;
    default:
      process.stderr.write(`harness: unknown command "${args.command}"\n`);
      process.stderr.write(usage() + "\n");
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `harness: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
