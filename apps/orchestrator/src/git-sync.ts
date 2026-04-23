// Git-side coda for the plan-file migration. After `run_task.sh` exits 0 the
// working tree is parked on `task/<id>-<slug>` with the run's own commits.
// Writing the status flip from `active/` → `completed/` straight into that
// checkout left the working tree dirty, which caused the next `run_task.sh`
// invocation to die at `ensure_task_branch`'s cleanliness guard and
// degenerate the orchestrator into single-shot mode. These helpers return the
// checkout to `main` before the migration and then commit+push the flip on
// `main`, so the next plan sees a clean tree on the branch its runner expects.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface GitSyncResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export function isGitRepo(repoRoot: string): boolean {
  const marker = path.join(repoRoot, ".git");
  if (!existsSync(marker)) return false;
  // `.git` is usually a directory; worktrees make it a file pointing at the
  // real gitdir. Either counts.
  try {
    const s = statSync(marker);
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

export function currentBranch(repoRoot: string): string | null {
  const res = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

export function worktreeClean(repoRoot: string): boolean {
  const res = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) return false;
  return res.stdout.trim().length === 0;
}

// Return the checkout to `main` so the next `run_task.sh` sees a clean tree
// on the branch its runner starts from. Pull `origin/main` with
// `--ff-only` — any non-fast-forward is a signal local `main` diverged and
// the operator should intervene. The pull is best-effort: offline /
// push-failed environments still let the migration proceed locally.
export function returnToMain(
  repoRoot: string,
  mainBranch = "main",
): GitSyncResult {
  if (!isGitRepo(repoRoot)) return { attempted: false, ok: true };
  const current = currentBranch(repoRoot);
  if (current !== mainBranch) {
    if (!worktreeClean(repoRoot)) {
      return {
        attempted: true,
        ok: false,
        reason: `worktree dirty on branch ${current ?? "(detached)"}; cannot switch to ${mainBranch}`,
      };
    }
    const checkout = spawnSync("git", ["checkout", mainBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (checkout.status !== 0) {
      return {
        attempted: true,
        ok: false,
        reason: `git checkout ${mainBranch} failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      };
    }
  }
  const pull = spawnSync("git", ["pull", "--ff-only", "origin", mainBranch], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (pull.status !== 0) {
    // Don't block the migration on pull failure — the remote may be offline
    // or the origin may not be configured (local-only runs). The caller
    // still commits locally and pushes below.
    return {
      attempted: true,
      ok: true,
      reason: `git pull origin ${mainBranch} failed (non-fatal): ${pull.stderr.trim() || pull.stdout.trim()}`,
    };
  }
  return { attempted: true, ok: true };
}

// Commit the migration so the working tree ends clean. If nothing is staged
// (the PR for this plan already landed a migration commit on `main`), this
// is a no-op. Push is best-effort — a failure here is surfaced in the
// reason but doesn't abort the caller: the commit has landed locally and the
// next push cycle can fix it up.
export function commitAndPushMigration(
  repoRoot: string,
  paths: readonly string[],
  commitMessage: string,
  mainBranch = "main",
): GitSyncResult {
  if (!isGitRepo(repoRoot)) return { attempted: false, ok: true };
  const relPaths = paths.map((p) =>
    path.isAbsolute(p) ? path.relative(repoRoot, p) : p,
  );
  // `git add --` tolerates deleted paths (the `active/` side of the move).
  const add = spawnSync("git", ["add", "--", ...relPaths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (add.status !== 0) {
    return {
      attempted: true,
      ok: false,
      reason: `git add failed: ${add.stderr.trim() || add.stdout.trim()}`,
    };
  }
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repoRoot,
  });
  // Exit 0 → no staged changes → already up-to-date. Exit 1 → staged changes.
  if (diff.status === 0) {
    return { attempted: true, ok: true, reason: "no staged changes" };
  }
  const commit = spawnSync("git", ["commit", "-m", commitMessage], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (commit.status !== 0) {
    return {
      attempted: true,
      ok: false,
      reason: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    };
  }
  const push = spawnSync("git", ["push", "origin", mainBranch], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (push.status !== 0) {
    return {
      attempted: true,
      ok: true,
      reason: `git push origin ${mainBranch} failed (non-fatal): ${push.stderr.trim() || push.stdout.trim()}`,
    };
  }
  return { attempted: true, ok: true };
}

// ---------------------------------------------------------------------------
// PR merge-state verification (plan 0056 follow-up — the orchestrator was
// previously trusting `run_task.sh` exit-0 as proof of "plan shipped," which
// silently marked plans complete even when the PR was closed-without-merge,
// blocked on CI, or just stuck open. This helper asks GitHub directly and
// returns a structured verdict the runPlan loop can route on.)
// ---------------------------------------------------------------------------

export type PRMergeState =
  | { merged: true; prNumber: number; prState: "MERGED" }
  | {
      merged: false;
      reason: string;
      prNumber: number | null;
      prState: string | null;
    };

/**
 * Returns whether the PR associated with `branch` in this repo has actually
 * merged. Uses `gh pr list` to find the PR (matches on --head) then inspects
 * its state and mergedAt. Any branch without an associated PR, or a PR that
 * is not MERGED, yields { merged: false, reason }.
 *
 * Designed to be safe on error paths: gh failures (missing auth, network
 * blip, repo misconfigured) produce { merged: false, reason: <detail> }
 * rather than throwing — the caller will treat this as "not merged yet"
 * and block the plan, which is the right behavior. A rate-limit-driven
 * false negative is recoverable; a silent assume-merge is not.
 */
export function checkPRMergeState(
  repoRoot: string,
  branch: string,
): PRMergeState {
  // Scaffolded test repos aren't real git repos — mirror the optimistic
  // short-circuit that returnToMain/commitAndPushMigration use, so the
  // daemon's happy-path tests don't need to stub this bridge method.
  if (!isGitRepo(repoRoot)) {
    return { merged: true, prNumber: 0, prState: "MERGED" };
  }
  // `--state all` so we see closed-but-not-merged PRs (a common failure mode
  // in the bug this helper is fixing). `--limit 1` because branch→PR is 1:1
  // for the harness's convention. JSON fields selected are minimal.
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,state,mergedAt",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    return {
      merged: false,
      prNumber: null,
      prState: null,
      reason: `gh pr list failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
    };
  }
  let prs: Array<{
    number: number;
    state: string;
    mergedAt: string | null;
  }>;
  try {
    prs = JSON.parse(result.stdout);
  } catch (err) {
    return {
      merged: false,
      prNumber: null,
      prState: null,
      reason: `gh pr list returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (prs.length === 0) {
    return {
      merged: false,
      prNumber: null,
      prState: null,
      reason: `no PR found for head branch ${branch}`,
    };
  }
  const pr = prs[0]!;
  if (pr.state === "MERGED" && pr.mergedAt) {
    return { merged: true, prNumber: pr.number, prState: "MERGED" };
  }
  return {
    merged: false,
    prNumber: pr.number,
    prState: pr.state,
    reason: `PR #${pr.number} state=${pr.state}, mergedAt=${pr.mergedAt ?? "null"}`,
  };
}
