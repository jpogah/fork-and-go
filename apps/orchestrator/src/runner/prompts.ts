// Prompt builders. Direct port of the heredocs in run_task.sh.
// Repo-specific prose ("apps/web", "next.js") is gone; the prompts only
// reference paths that come from the resolved RunContext.

import { readFileSync, existsSync } from "node:fs";

import type { RunContext } from "./types.ts";

export function implementationPrompt(ctx: RunContext): string {
  const contextSection = loadContextSection(ctx);
  return [
    `Read the execution plan at \`${ctx.planRel}\` and the checked-in workflow and prompt docs it references.`,
    "",
    `Execute only the "Implement" section from the plan.`,
    "",
    "Constraints:",
    "- Follow the plan as the source of truth.",
    "- Do not move to review, PR preparation, or merge steps.",
    "- If blocked by ambiguity the plan cannot resolve, stop and explain the blocker.",
    "- At the end, summarize: acceptance criteria, implementation summary, validation performed, risks, follow-ups.",
    contextSection ? "\n" + contextSection : "",
  ].join("\n");
}

export function reviewPrompt(ctx: RunContext): string {
  const contextSection = loadContextSection(ctx);
  return [
    `Read \`${ctx.planRel}\` and \`docs/prompts/self-review.md\`.`,
    "",
    `Execute only the "Review" section from the plan.`,
    "",
    `Review the current branch changes against \`${ctx.baseBranch}\`.`,
    "Use local git diff and repository files for context.",
    "Do not modify files.",
    "",
    "Severity levels (per `docs/prompts/self-review.md`): Critical, High, Medium,",
    "Low. Critical/High/Medium are blocking. Low is NOT blocking — list Lows as",
    "tracked follow-ups but do not re-raise the same Low across passes once it has",
    "been acknowledged.",
    "",
    "Output rules:",
    "- The FIRST LINE of your response must be exactly one of:",
    "  - `No findings.` — nothing to report at any severity.",
    "  - `No blocking findings.` — only Low-severity findings remain; list those",
    "    Lows after the sentinel as follow-ups.",
    "  - The first finding's severity heading (e.g. `### Critical`), when blocking",
    "    findings exist.",
    "- Do not include preamble, meta-commentary, or a \"verified invariants\" list",
    "  before the sentinel or first finding. Any such notes belong AFTER findings.",
    "- List findings ordered by severity, with file references for every item.",
    contextSection ? "\n" + contextSection : "",
  ].join("\n");
}

export function reviewUiPrompt(ctx: RunContext, devUrl: string): string {
  return [
    `Read \`${ctx.planRel}\` and \`docs/prompts/self-review.md\`.`,
    "",
    `Execute only the "Review" section from the plan.`,
    "",
    `A dev server is running at \`${devUrl}\`. In addition to reviewing the code`,
    `diff against \`${ctx.baseBranch}\`, use the Playwright MCP tools (browser_navigate,`,
    "browser_snapshot, browser_click, browser_resize, browser_press_key,",
    "browser_take_screenshot, browser_console_messages, etc.) to verify the plan's",
    "user-facing acceptance criteria against the rendered page.",
    "",
    "Specifically check:",
    "- Visual hierarchy and first-viewport content described in the plan",
    "- Responsive behavior at 360px, 768px, and 1280px viewport widths",
    "- Keyboard navigation and visible focus states",
    "- Any other acceptance-criteria items that require a rendered page",
    "- Console errors and warnings",
    "",
    "Use local git diff and repository files for code review context.",
    "Do not modify files.",
    "",
    "Save any browser screenshots under `.playwright-mcp/screenshots/` (the",
    "directory is gitignored) so review artifacts do not pollute the repo root.",
    "",
    "Output rules:",
    "- Start the final response with `No findings.` if there are no findings.",
    "- Otherwise list findings first, ordered by severity, with file references and",
    "  browser-state evidence (URL, viewport, snapshot excerpt) where relevant.",
  ].join("\n");
}

export function fixPrompt(ctx: RunContext, findingsBody: string): string {
  const contextSection = loadContextSection(ctx);
  return [
    `Read \`${ctx.planRel}\`, \`docs/prompts/fix-review-findings.md\`, and the review findings below.`,
    "",
    `Execute only the "Fix" section from the plan.`,
    "",
    "Review findings:",
    "",
    findingsBody,
    contextSection ? "\n" + contextSection : "",
  ].join("\n");
}

export function preparePrPrompt(ctx: RunContext, seedBody: string): string {
  return [
    `Read \`${ctx.planRel}\`, \`docs/prompts/prepare-pr.md\`, and \`docs/workflows/agent-delivery-loop.md\`.`,
    "",
    `Using the generated PR body below and the current diff against \`${ctx.baseBranch}\`, execute only the "Prepare PR" section from the plan.`,
    "",
    'Under "Review Loop", tick `- [x] Self-review loop converged with no blocking findings` — the self-review loop has already converged by the time this phase runs.',
    "",
    "Leave `- [ ] agent/automerge will only be added when the PR is ready` unchecked; the merge-check phase applies the label.",
    "",
    "Output rules:",
    "- Output ONLY the final PR body as Markdown. The very first line of your response must be `## Summary`.",
    "- Do not include any preamble, planning notes, meta-commentary, or explanatory text before or after the Markdown.",
    "- Do not wrap the response in code fences.",
    "",
    "Generated PR body:",
    "",
    seedBody,
  ].join("\n");
}

export function mergeCheckPrompt(
  ctx: RunContext,
  prNumber: number,
  e2eRel: string,
): string {
  const e2eGate = ctx.skipE2e
    ? "The merge-check invocation was run with `--skip-e2e`, so no `e2e-verify.out.md` was produced for this run. Cite the opt-out explicitly in your output (the plan must be tagged as non-UI-touching for this to be acceptable). Do not look at `.task-runs/<id>/latest/` — that symlink moves with every run and is not a reliable witness."
    : `The merge-check invocation has just produced this run's e2e-verify artifact at:\n\`${e2eRel}\`\n\nGate on that file specifically. Its first non-empty line must be exactly \`E2E verification passed.\`. Do not read from \`.task-runs/<id>/latest/\` — that symlink moves with every run and is not a reliable witness for this run.`;

  return [
    `Read \`${ctx.planRel}\` and \`docs/prompts/merge-readiness.md\`.`,
    "",
    `Execute only the "Check Merge Readiness" section from the plan for PR #${prNumber}.`,
    "Use GitHub CLI and local git context as needed.",
    "Do not modify files.",
    "",
    "E2E verification gate (this invocation):",
    e2eGate,
    "",
    "Output rules:",
    "- If the PR is ready, start the final response with `No findings. Ready to enable auto-merge.`",
    "- Otherwise list findings first, ordered by severity, with file references where applicable.",
  ].join("\n");
}

// Optional context drop section. Best-effort: if the target repo doesn't
// commit `<contextDir>/<phase>.md` files, we just emit nothing.
function loadContextSection(ctx: RunContext): string {
  const contextDir = ctx.config.contextDir;
  if (!contextDir) return "";
  const candidate = `${ctx.repoRoot}/${contextDir}/${ctx.planPhase || "all"}.md`;
  if (!existsSync(candidate)) return "";
  try {
    const body = readFileSync(candidate, "utf8").trim();
    if (!body) return "";
    return ["## External Context", "", body].join("\n");
  } catch {
    return "";
  }
}
