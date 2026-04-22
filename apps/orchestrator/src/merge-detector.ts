// Polls GitHub for merged PRs on the base branch via `gh pr list`. Dedupes
// by merge commit SHA so each merge fires exactly once, and surfaces the
// event via a callback so the main loop can consult the plan graph.

import { spawn } from "node:child_process";

export interface MergedPr {
  number: number;
  title: string;
  headRefName: string;
  mergeCommit: string | null;
  mergedAt: string | null;
}

export interface MergeDetectorOptions {
  baseBranch?: string;
  limit?: number;
  ghPath?: string;
  // Function that runs `gh pr list` and returns parsed entries. Tests pass a
  // fake; production uses the default implementation that shells out.
  fetchMerged?: (opts: {
    baseBranch: string;
    limit: number;
  }) => Promise<MergedPr[]>;
  now?: () => Date;
}

export interface DetectedMerge {
  pr: MergedPr;
  firstSeenAt: string;
}

export interface MergeDetector {
  // Fetches the latest merged PRs, diffs against the cached SHA, and returns
  // any newly observed merges in chronological order (oldest first).
  poll(lastMergeSha: string | null): Promise<{
    merges: DetectedMerge[];
    latestSha: string | null;
  }>;
}

const DEFAULT_FIELDS = [
  "number",
  "title",
  "headRefName",
  "mergeCommit",
  "mergedAt",
] as const;

export function createMergeDetector(
  options: MergeDetectorOptions = {},
): MergeDetector {
  const baseBranch = options.baseBranch ?? "main";
  const limit = options.limit ?? 5;
  const ghPath = options.ghPath ?? "gh";
  const now = options.now ?? (() => new Date());
  const fetchMerged = options.fetchMerged ?? createGhFetcher(ghPath);

  return {
    async poll(lastMergeSha) {
      const recent = await fetchMerged({ baseBranch, limit });
      const newestSha =
        recent.find((pr) => pr.mergeCommit !== null)?.mergeCommit ?? null;

      // Cold start: no anchor, just record the newest sha and wait for
      // subsequent polls. Replaying the window on a cold boot would flood
      // the history and mis-attribute pre-existing merges as "new".
      if (lastMergeSha === null) {
        return { merges: [], latestSha: newestSha };
      }

      // `gh pr list --state merged` returns most-recent first. Reverse so we
      // replay in merge order and don't skip older merges that weren't yet
      // observed last tick.
      const ordered = [...recent].reverse();
      const merges: DetectedMerge[] = [];
      let reachedAnchor = false;
      let latestSha = lastMergeSha;
      for (const pr of ordered) {
        if (!pr.mergeCommit) continue;
        if (!reachedAnchor) {
          if (pr.mergeCommit === lastMergeSha) {
            reachedAnchor = true;
          }
          continue;
        }
        merges.push({ pr, firstSeenAt: now().toISOString() });
        latestSha = pr.mergeCommit;
      }

      // Anchor scrolled off the window (busy repo, stale cache). Skip the
      // replay and re-anchor to the newest merge — flooding the history
      // here is worse than losing a few events.
      if (!reachedAnchor) {
        return {
          merges: [],
          latestSha: newestSha ?? lastMergeSha,
        };
      }
      return { merges, latestSha };
    },
  };
}

function createGhFetcher(
  ghPath: string,
): (opts: { baseBranch: string; limit: number }) => Promise<MergedPr[]> {
  return async ({ baseBranch, limit }) => {
    const args = [
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      baseBranch,
      "--limit",
      String(limit),
      "--json",
      DEFAULT_FIELDS.join(","),
    ];
    const stdout = await runGh(ghPath, args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`gh pr list returned non-JSON output: ${msg}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("gh pr list did not return a JSON array");
    }
    return parsed.map(normalizePr).filter((pr): pr is MergedPr => pr !== null);
  };
}

function normalizePr(raw: unknown): MergedPr | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.number !== "number") return null;
  const title = typeof obj.title === "string" ? obj.title : "";
  const headRefName =
    typeof obj.headRefName === "string" ? obj.headRefName : "";
  const mergeCommit =
    obj.mergeCommit && typeof obj.mergeCommit === "object"
      ? (obj.mergeCommit as Record<string, unknown>).oid
      : typeof obj.mergeCommit === "string"
        ? obj.mergeCommit
        : null;
  const mergedAt = typeof obj.mergedAt === "string" ? obj.mergedAt : null;
  return {
    number: obj.number,
    title,
    headRefName,
    mergeCommit: typeof mergeCommit === "string" ? mergeCommit : null,
    mergedAt,
  };
}

function runGh(ghPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `gh ${args.join(" ")} exited ${code}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
    });
  });
}
