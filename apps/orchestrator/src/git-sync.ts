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
