// Thin promise wrappers around git/gh. We shell out (not agent calls) —
// these are infrastructure, not a model role. The wrappers expose only
// the shape the runner actually needs.

import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execCmd(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): Promise<ExecResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export async function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<ExecResult> {
  return await execCmd("git", args, { cwd });
}

export async function gh(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<ExecResult> {
  return await execCmd("gh", args, { cwd });
}

export async function ghReady(cwd: string): Promise<boolean> {
  try {
    const which = await execCmd("which", ["gh"], { cwd });
    if (which.exitCode !== 0) return false;
    const status = await gh(cwd, ["auth", "status"]);
    return status.exitCode === 0;
  } catch {
    return false;
  }
}

export async function gitHasOrigin(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["remote", "get-url", "origin"]);
  return result.exitCode === 0;
}

export async function workingTreeClean(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["status", "--porcelain"]);
  return result.exitCode === 0 && result.stdout.trim() === "";
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return !(await workingTreeClean(cwd));
}

export async function currentBranch(cwd: string): Promise<string> {
  const result = await git(cwd, ["branch", "--show-current"]);
  return result.stdout.trim();
}

export async function branchExists(
  cwd: string,
  branch: string,
): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--verify", branch]);
  return result.exitCode === 0;
}

export async function ensureBranch(
  cwd: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  const cur = await currentBranch(cwd);
  if (cur === branch) return;
  if (!(await workingTreeClean(cwd))) {
    throw new Error(
      `working tree must be clean before switching to ${branch}`,
    );
  }
  if (await branchExists(cwd, branch)) {
    const co = await git(cwd, ["checkout", branch]);
    if (co.exitCode !== 0) throw new Error(`git checkout ${branch}: ${co.stderr}`);
  } else {
    const co = await git(cwd, ["checkout", "-b", branch]);
    if (co.exitCode !== 0) throw new Error(`git checkout -b ${branch}: ${co.stderr}`);
  }
  await git(cwd, ["config", `branch.${branch}.gh-merge-base`, baseBranch]);
}

export async function hasDiffAgainstBase(
  cwd: string,
  baseBranch: string,
): Promise<boolean> {
  const remote = await git(cwd, ["rev-parse", "--verify", `origin/${baseBranch}`]);
  const ref = remote.exitCode === 0 ? `origin/${baseBranch}` : baseBranch;
  const diff = await git(cwd, ["diff", "--quiet", `${ref}...HEAD`]);
  // `--quiet` exits 1 when there is a diff, 0 when clean.
  return diff.exitCode === 1;
}

export async function commitAll(
  cwd: string,
  message: string,
  options: { allowEmpty?: boolean; noVerify?: boolean } = {},
): Promise<void> {
  await git(cwd, ["add", "-A"]);
  const args = ["commit", "-m", message];
  if (options.noVerify) args.push("--no-verify");
  if (options.allowEmpty) args.push("--allow-empty");
  const result = await git(cwd, args);
  if (result.exitCode !== 0 && !/nothing to commit/i.test(result.stderr)) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
  const result = await git(cwd, ["push", "-u", "origin", branch]);
  if (result.exitCode !== 0) {
    throw new Error(`git push failed: ${result.stderr}`);
  }
}

export interface PrInfo {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export async function viewCurrentPr(cwd: string): Promise<PrInfo | null> {
  const result = await gh(cwd, ["pr", "view", "--json", "number,state"]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as PrInfo;
    return parsed;
  } catch {
    return null;
  }
}

export async function createPr(
  cwd: string,
  args: { baseBranch: string; head: string; title: string; bodyFile: string },
): Promise<void> {
  const result = await gh(cwd, [
    "pr",
    "create",
    "--base",
    args.baseBranch,
    "--head",
    args.head,
    "--title",
    args.title,
    "--body-file",
    args.bodyFile,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr create failed: ${result.stderr}`);
  }
}

export async function editPr(
  cwd: string,
  prNumber: number,
  args: { title: string; bodyFile: string },
): Promise<void> {
  const result = await gh(cwd, [
    "pr",
    "edit",
    String(prNumber),
    "--title",
    args.title,
    "--body-file",
    args.bodyFile,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr edit failed: ${result.stderr}`);
  }
}

export async function reopenPr(cwd: string, prNumber: number): Promise<boolean> {
  const result = await gh(cwd, ["pr", "reopen", String(prNumber)]);
  return result.exitCode === 0;
}

export async function addAutomergeLabel(
  cwd: string,
  prNumber: number,
): Promise<void> {
  // Idempotently ensure the label exists, then attach it.
  const list = await gh(cwd, ["label", "list", "--limit", "200", "--json", "name"]);
  let alreadyExists = false;
  if (list.exitCode === 0) {
    try {
      const arr = JSON.parse(list.stdout) as Array<{ name: string }>;
      alreadyExists = arr.some((l) => l.name === "agent/automerge");
    } catch {
      // Falls through to create.
    }
  }
  if (!alreadyExists) {
    await gh(cwd, [
      "label",
      "create",
      "agent/automerge",
      "--color",
      "0E8A16",
      "--description",
      "Agent may enable auto-merge when PR is ready",
    ]);
  }
  await gh(cwd, ["pr", "edit", String(prNumber), "--add-label", "agent/automerge"]);
}
