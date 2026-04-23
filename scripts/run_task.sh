#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_BRANCH="main"
PHASE="all"
MODEL=""
DRY_RUN=0
LOCAL_ONLY=0
SKIP_E2E=0
MAX_REVIEW_PASSES=5
TASK_REF=""
AGENT="${TASK_RUNNER_AGENT:-claude}"

usage() {
  cat <<'EOF'
Usage: ./scripts/run_task.sh <task-id-or-plan-path> [options]

Options:
  --phase <phase>             One of: all, implement, review, review-ui, fix, prepare-pr, e2e-verify, merge-check
  --base <branch>             Base branch to compare and open PRs against (default: main)
  --agent <name>              Coding agent CLI to drive phases: claude (default) or codex.
                              Also settable via TASK_RUNNER_AGENT env var.
  --model <model>             Model override passed through to the agent
  --local-only                Skip push, PR, and merge operations
  --skip-e2e                  Skip the e2e-verify phase in all mode. Only use for
                              plans explicitly tagged as non-UI-touching.
  --max-review-passes <n>     Max review/fix passes in all mode (default: 5)
  --dry-run                   Print actions without executing agent, git, or gh commands
  -h, --help                  Show this help

Phases:
  review                      Text-only code review. Fast and cheap; reviewer is
                              restricted to Read/Grep/Glob/Bash.
  review-ui                   Boots the dev server, gives the reviewer browser
                              automation (Playwright MCP must be installed), and
                              asks it to verify the plan's acceptance criteria in a
                              rendered page. Slower; use for UI-heavy plans.

Environment:
  TASK_RUNNER_AGENT           Default agent (claude or codex). Overridden by --agent.
  MERGE_CHECK_WAIT_SECONDS    Max seconds to wait for CI before running merge-readiness.
                              Default: 900 (15 minutes).
  DEV_SERVER_URL              URL the review-ui phase polls for readiness.
                              Default: http://localhost:3000.
  DEV_SERVER_READY_TIMEOUT    Max seconds to wait for the dev server.
                              Default: 60.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

note() {
  echo "==> $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE="${2:-}"
      shift 2
      ;;
    --base)
      BASE_BRANCH="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --agent)
      AGENT="${2:-}"
      shift 2
      ;;
    --local-only)
      LOCAL_ONLY=1
      shift
      ;;
    --skip-e2e)
      SKIP_E2E=1
      shift
      ;;
    --max-review-passes)
      MAX_REVIEW_PASSES="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$TASK_REF" ]]; then
        die "Unexpected argument: $1"
      fi
      TASK_REF="$1"
      shift
      ;;
  esac
done

[[ -n "$TASK_REF" ]] || {
  usage
  exit 1
}

case "$PHASE" in
  all|implement|review|review-ui|fix|prepare-pr|e2e-verify|merge-check) ;;
  *)
    die "Unsupported phase: $PHASE"
    ;;
esac

case "$AGENT" in
  claude|codex) ;;
  *) die "Unsupported agent: $AGENT (use claude or codex)" ;;
esac

command -v "$AGENT" >/dev/null 2>&1 || die "$AGENT CLI is required"
command -v git >/dev/null 2>&1 || die "git is required"

# Freeze check (plan 0052): `.orchestrator/FROZEN` halts all runs cleanly.
# The sentinel survives orchestrator restart and is operator-visible; we check
# at the top so a frozen system never spawns a fresh claude child.
FROZEN_FILE="$ROOT/.orchestrator/FROZEN"
if [[ -f "$FROZEN_FILE" ]]; then
  freeze_note="$(cat "$FROZEN_FILE" 2>/dev/null || true)"
  echo "ERROR: Harness is frozen ($FROZEN_FILE exists); refusing to start." >&2
  if [[ -n "$freeze_note" ]]; then
    echo "Freeze note:" >&2
    echo "$freeze_note" >&2
  fi
  echo "Remove the file (or POST /unfreeze to the orchestrator) to resume." >&2
  exit 3
fi

resolve_plan() {
  if [[ -f "$TASK_REF" ]]; then
    printf '%s\n' "$TASK_REF"
    return
  fi

  local matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(find "$ROOT/docs/exec-plans/active" -maxdepth 1 -type f -name "${TASK_REF}-*.md" | sort)

  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf '%s\n' "${matches[0]}"
    return
  fi

  if [[ "${#matches[@]}" -eq 0 ]]; then
    die "Could not resolve plan for task ref: $TASK_REF"
  fi

  die "Task ref $TASK_REF matches multiple plans"
}

PLAN_PATH="$(resolve_plan)"
PLAN_PATH="$(cd "$(dirname "$PLAN_PATH")" && pwd)/$(basename "$PLAN_PATH")"
PLAN_REL="${PLAN_PATH#$ROOT/}"
TASK_FILE="$(basename "$PLAN_PATH")"
TASK_ID="$(printf '%s' "$TASK_FILE" | sed -E 's/^([0-9]{4}).*/\1/')"
TASK_SLUG="$(printf '%s' "${TASK_FILE%.md}" | sed -E "s/^${TASK_ID}-//")"
TASK_BRANCH="task/${TASK_ID}-${TASK_SLUG}"
# Extract the first Markdown H1 from the plan file. Works whether the plan
# leads with YAML frontmatter (introduced by 0048) or jumps straight into
# the heading — grep skips the `---` delimiter lines and picks the first
# `# <title>` line it finds.
TASK_TITLE="$(grep -m1 '^# ' "$PLAN_PATH" | sed 's/^# //')"
COMMIT_TITLE="$TASK_TITLE"
PR_TITLE="$TASK_TITLE"

# Extract the plan's `phase:` frontmatter value for context-scope matching
# (see 0051). The plan-graph schema guarantees quoted strings when plans
# are fully formed; we trim quotes + whitespace defensively and fall back
# to an empty string so `load_context` can still render `all`/`run:`
# scoped drops when the frontmatter is missing.
TASK_PHASE="$(awk '
  /^---$/ { count++; if (count == 2) exit; next }
  count == 1 && /^phase:/ { sub(/^phase:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }
' "$PLAN_PATH")"

RUN_ROOT="$ROOT/.task-runs/$TASK_ID"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$RUN_ROOT/$RUN_ID"

mkdir -p "$RUN_DIR"
ln -sfn "$RUN_DIR" "$RUN_ROOT/latest"

if [[ "$AGENT" == "codex" ]]; then
  # `--json` emits JSONL events to stdout so scripts/agent-log.mjs can pull
  # real token counts out of `turn.completed.usage` (plan 0052). `-o` keeps
  # writing the final message to the output file for review-sentinel parsing.
  AGENT_EXEC_ARGS=(codex exec --full-auto --ephemeral --color never --json -C "$ROOT")
  AGENT_REVIEW_ARGS=(codex exec --sandbox read-only --ephemeral --color never --json -C "$ROOT")
  # Codex sandbox doesn't have Playwright; review-ui falls back to the same read-only
  # sandbox and relies on the prompt for UI guidance.
  AGENT_REVIEW_UI_ARGS=(codex exec --sandbox read-only --ephemeral --color never --json -C "$ROOT")
else
  # `--output-format json` gives us `result` + `usage` in one JSON object at
  # the end of the run, which we split into an output file + a tokens-used
  # record (plan 0052). Without this the budget ceiling never trips because
  # the text-mode CLI doesn't emit token counts.
  AGENT_EXEC_ARGS=(claude -p --output-format json --permission-mode bypassPermissions --add-dir "$ROOT")
  # Text review: tight allow-list — no writes, no network, no MCP. Fast and cheap.
  AGENT_REVIEW_ARGS=(claude -p --output-format json --permission-mode bypassPermissions --allowed-tools "Read,Grep,Glob,Bash" --add-dir "$ROOT")
  # UI review: block writes, allow everything else (including MCP tools like
  # Playwright). Assumes a Playwright MCP server is configured at the user or
  # project level.
  AGENT_REVIEW_UI_ARGS=(claude -p --output-format json --permission-mode bypassPermissions --disallowed-tools "Edit,Write,NotebookEdit" --add-dir "$ROOT")
fi
if [[ -n "$MODEL" ]]; then
  AGENT_EXEC_ARGS+=(--model "$MODEL")
  AGENT_REVIEW_ARGS+=(--model "$MODEL")
  AGENT_REVIEW_UI_ARGS+=(--model "$MODEL")
fi

git_has_origin() {
  git remote get-url origin >/dev/null 2>&1
}

gh_ready() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

if [[ "$LOCAL_ONLY" -eq 0 ]] && (! git_has_origin || ! gh_ready); then
  note "GitHub remote or auth is unavailable. Falling back to local-only mode."
  LOCAL_ONLY=1
fi

worktree_clean() {
  [[ -z "$(git status --porcelain)" ]]
}

has_uncommitted_changes() {
  [[ -n "$(git status --porcelain)" ]]
}

has_diff_against_base() {
  if git rev-parse --verify "origin/$BASE_BRANCH" >/dev/null 2>&1; then
    ! git diff --quiet "origin/$BASE_BRANCH"...HEAD
  else
    ! git diff --quiet "$BASE_BRANCH"...HEAD
  fi
}

ensure_task_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"

  if [[ "$current_branch" == "$TASK_BRANCH" ]]; then
    return
  fi

  worktree_clean || die "Working tree must be clean before switching to $TASK_BRANCH"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: would switch to branch $TASK_BRANCH"
    return
  fi

  if git rev-parse --verify "$TASK_BRANCH" >/dev/null 2>&1; then
    note "Switching to existing branch $TASK_BRANCH"
    git checkout "$TASK_BRANCH"
  else
    note "Creating branch $TASK_BRANCH"
    git checkout -b "$TASK_BRANCH"
  fi

  git config "branch.$TASK_BRANCH.gh-merge-base" "$BASE_BRANCH"
}

first_nonempty_line() {
  local file="$1"
  awk 'NF { print; exit }' "$file"
}

review_is_clean() {
  local file="$1"
  [[ -f "$file" ]] || die "Missing review output file: $file"
  local first
  first="$(first_nonempty_line "$file")"
  # Happy path: first non-empty line is the sentinel (what the prompt demands).
  if [[ "$first" == "No findings."* || "$first" == "No blocking findings."* ]]; then
    return 0
  fi
  # Defensive fallback: some models still include a preamble paragraph before
  # the sentinel. Treat the review as converged if the sentinel appears as a
  # standalone line anywhere in the file (no leading/trailing text on the line).
  if grep -qE '^(No findings\.|No blocking findings\.)\s*$' "$file"; then
    return 0
  fi
  return 1
}

merge_is_ready() {
  local file="$1"
  [[ -f "$file" ]] || die "Missing merge output file: $file"
  local first
  first="$(first_nonempty_line "$file")"
  # Happy path: first non-empty line is the sentinel (what the prompt demands).
  if [[ "$first" == "No findings. Ready to enable auto-merge."* ]]; then
    return 0
  fi
  # Defensive fallback, mirroring `review_is_clean` (28ee9b7): some models emit
  # a preamble bullet listing verified invariants before the sentinel. Treat
  # the review as green if the sentinel appears as a standalone line anywhere
  # in the file — strict about format, forgiving about placement.
  if grep -qE '^No findings\. Ready to enable auto-merge\.\s*$' "$file"; then
    return 0
  fi
  return 1
}

# Renders the "## External Context" section for a runner prompt by shelling
# out to `scripts/context.sh render` (0051). Output is the fully rendered
# block — empty when no matching drops exist — so prompt writers can safely
# inline it with no conditional. Warnings from the renderer go to stderr and
# surface in the runner's tee'd log without polluting the prompt body.
load_context() {
  ./scripts/context.sh render --plan-id "$TASK_ID" --phase "$TASK_PHASE" || true
}

write_implementation_prompt() {
  local file="$1"
  local context_section
  context_section="$(load_context)"
  cat >"$file" <<EOF
Read the execution plan at \`${PLAN_REL}\` and the checked-in workflow and prompt docs it references.

Execute only the "Implement" section from the plan.

Constraints:
- Follow the plan as the source of truth.
- Do not move to review, PR preparation, or merge steps.
- If blocked by ambiguity the plan cannot resolve, stop and explain the blocker.
- At the end, summarize: acceptance criteria, implementation summary, validation performed, risks, follow-ups.
${context_section:+
${context_section}}
EOF
}

write_review_prompt() {
  local file="$1"
  local context_section
  context_section="$(load_context)"
  cat >"$file" <<EOF
Read \`${PLAN_REL}\` and \`docs/prompts/self-review.md\`.

Execute only the "Review" section from the plan.

Review the current branch changes against \`${BASE_BRANCH}\`.
Use local git diff and repository files for context.
Do not modify files.

Severity levels (per \`docs/prompts/self-review.md\`): Critical, High, Medium,
Low. Critical/High/Medium are blocking. Low is NOT blocking — list Lows as
tracked follow-ups but do not re-raise the same Low across passes once it has
been acknowledged.

Output rules:
- The FIRST LINE of your response must be exactly one of:
  - \`No findings.\` — nothing to report at any severity.
  - \`No blocking findings.\` — only Low-severity findings remain; list those
    Lows after the sentinel as follow-ups.
  - The first finding's severity heading (e.g. \`### Critical\`), when blocking
    findings exist.
- Do not include preamble, meta-commentary, or a "verified invariants" list
  before the sentinel or first finding. Any such notes belong AFTER findings.
- List findings ordered by severity, with file references for every item.
${context_section:+
${context_section}}
EOF
}

write_review_ui_prompt() {
  local file="$1"
  local dev_url="$2"
  cat >"$file" <<EOF
Read \`${PLAN_REL}\` and \`docs/prompts/self-review.md\`.

Execute only the "Review" section from the plan.

A dev server is running at \`${dev_url}\`. In addition to reviewing the code
diff against \`${BASE_BRANCH}\`, use the Playwright MCP tools (browser_navigate,
browser_snapshot, browser_click, browser_resize, browser_press_key,
browser_take_screenshot, browser_console_messages, etc.) to verify the plan's
user-facing acceptance criteria against the rendered page.

Specifically check:
- Visual hierarchy and first-viewport content described in the plan
- Responsive behavior at 360px, 768px, and 1280px viewport widths
- Keyboard navigation and visible focus states
- Any other acceptance-criteria items that require a rendered page
- Console errors and warnings

Use local git diff and repository files for code review context.
Do not modify files.

Save any browser screenshots under \`.playwright-mcp/screenshots/\` (the
directory is gitignored) so review artifacts do not pollute the repo root.

Output rules:
- Start the final response with \`No findings.\` if there are no findings.
- Otherwise list findings first, ordered by severity, with file references and
  browser-state evidence (URL, viewport, snapshot excerpt) where relevant.
EOF
}

write_fix_prompt() {
  local file="$1"
  local review_file="$2"
  local context_section
  context_section="$(load_context)"
  cat >"$file" <<EOF
Read \`${PLAN_REL}\`, \`docs/prompts/fix-review-findings.md\`, and the review findings below.

Execute only the "Fix" section from the plan.

Review findings:

$(cat "$review_file")
${context_section:+
${context_section}}
EOF
}

write_prepare_pr_prompt() {
  local file="$1"
  local seed_file="$2"
  cat >"$file" <<EOF
Read \`${PLAN_REL}\`, \`docs/prompts/prepare-pr.md\`, and \`docs/workflows/agent-delivery-loop.md\`.

Using the generated PR body below and the current diff against \`${BASE_BRANCH}\`, execute only the "Prepare PR" section from the plan.

Under "Review Loop", tick \`- [x] Self-review loop converged with no blocking findings\` — the self-review loop has already converged by the time this phase runs.

Leave \`- [ ] agent/automerge will only be added when the PR is ready\` unchecked; the merge-check phase applies the label.

Output rules:
- Output ONLY the final PR body as Markdown. The very first line of your response must be \`## Summary\`.
- Do not include any preamble, planning notes, meta-commentary, or explanatory text before or after the Markdown.
- Do not wrap the response in code fences.

Generated PR body:

$(cat "$seed_file")
EOF
}

write_merge_prompt() {
  local file="$1"
  local pr_number="$2"
  local e2e_summary_rel="${RUN_DIR#$ROOT/}/e2e-verify.out.md"
  local e2e_gate_block
  if (( SKIP_E2E == 1 )); then
    e2e_gate_block="The merge-check invocation was run with \`--skip-e2e\`, so no \`e2e-verify.out.md\` was produced for this run. Cite the opt-out explicitly in your output (the plan must be tagged as non-UI-touching for this to be acceptable). Do not look at \`.task-runs/<id>/latest/\` — that symlink moves with every \`run_task.sh\` invocation and is not a reliable witness."
  else
    e2e_gate_block="The merge-check invocation has just produced this run's e2e-verify artifact at:
\`${e2e_summary_rel}\`

Gate on that file specifically. Its first non-empty line must be exactly \`E2E verification passed.\`. Do not read from \`.task-runs/<id>/latest/\` — that symlink moves with every \`run_task.sh\` invocation and is not a reliable witness for this run."
  fi
  cat >"$file" <<EOF
Read \`${PLAN_REL}\` and \`docs/prompts/merge-readiness.md\`.

Execute only the "Check Merge Readiness" section from the plan for PR #${pr_number}.
Use GitHub CLI and local git context as needed.
Do not modify files.

E2E verification gate (this invocation):
${e2e_gate_block}

Output rules:
- If the PR is ready, start the final response with \`No findings. Ready to enable auto-merge.\`
- Otherwise list findings first, ordered by severity, with file references where applicable.
EOF
}

# Rate-limit + budget bookkeeping (plan 0052).
#
# `detect_rate_limit` shells out to scripts/rate-limit-detect.mjs which wraps
# the shared @agently/run-budget regex. On a hit, we commit the current tree
# with a `wip: rate-limited during <phase>` message — `--no-verify` is the
# intentional bypass for WIP commits so pre-commit hooks don't block a run we
# already know is aborting — then exit 2 (distinct from 1 = code failure) so
# the branch state is preserved for resume.
# record_tokens_used appends an NDJSON line to tokens-used.json per agent
# invocation, pulling the actual input/output token counts out of the agent's
# JSON log via scripts/agent-log.mjs. Zeroes get written only when parsing
# fails (e.g. a malformed log from a killed child) so the orchestrator's
# aggregator still sees the record and can attribute it to a phase.
detect_rate_limit() {
  local log_file="$1"
  local phase="$2"
  [[ -s "$log_file" ]] || return 0
  # `--experimental-strip-types` is required because rate-limit-detect.mjs
  # imports the shared detector's `.ts` source; without the flag Node <23.6 /
  # <22.18 exits with ERR_UNKNOWN_FILE_EXTENSION and the caller would silently
  # treat that as "no rate limit detected" (the whole WIP-commit + exit-2 flow
  # would be disabled on the documented Node range).
  if node --experimental-strip-types "$ROOT/scripts/rate-limit-detect.mjs" "$log_file" >/dev/null 2>&1; then
    note "[rate-limit] Claude usage limit detected during ${phase}. Committing WIP and exiting code 2."
    if [[ "$DRY_RUN" -ne 1 ]] && has_uncommitted_changes; then
      git add -A
      git commit --no-verify -m "wip: rate-limited during ${phase}" >/dev/null 2>&1 || true
    fi
    exit 2
  fi
}

record_tokens_used() {
  local phase="$1"
  local log_file="${2:-}"
  # Prefer the model reported by the agent's own JSON log over $MODEL. Operators
  # rarely pass `--model`, so `${MODEL:-unknown}` used to record every run as
  # "unknown" and the cost estimator fell back to a conservative flat rate —
  # for claude-opus runs that under-counted cost by ~3x. The log already carries
  # the resolved model name; fall back to $MODEL / "unknown" only if parsing
  # fails (malformed log, killed child).
  local model="${MODEL:-}"
  local input_tokens=0
  local output_tokens=0
  if [[ -n "$log_file" && -s "$log_file" ]]; then
    local tokens_line
    if tokens_line="$(node "$ROOT/scripts/agent-log.mjs" tokens "$log_file" "$AGENT" 2>/dev/null)"; then
      input_tokens="$(printf '%s' "$tokens_line" | awk -F'\t' '{print $1}')"
      output_tokens="$(printf '%s' "$tokens_line" | awk -F'\t' '{print $2}')"
      local log_model
      log_model="$(printf '%s' "$tokens_line" | awk -F'\t' '{print $3}')"
      [[ "$input_tokens" =~ ^[0-9]+$ ]] || input_tokens=0
      [[ "$output_tokens" =~ ^[0-9]+$ ]] || output_tokens=0
      [[ -z "$model" && -n "$log_model" ]] && model="$log_model"
    fi
  fi
  [[ -n "$model" ]] || model="unknown"
  local record
  record=$(printf '{"phase":"%s","model":"%s","inputTokens":%s,"outputTokens":%s,"at":"%s"}' \
    "$phase" "$model" "$input_tokens" "$output_tokens" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  printf '%s\n' "$record" >>"$RUN_DIR/tokens-used.json"
}

# Splits the JSON/JSONL agent log into the text result the review-sentinel
# parser expects (written to $output_file). Claude emits one JSON object with
# a `result` field; codex writes the final message to `-o` directly, so this
# only runs on the claude path. Falls back to the raw log if extraction fails
# so the phase still has *something* to parse — an empty output would trip
# `review_is_clean`'s "missing output" guard for the wrong reason.
extract_claude_result() {
  local log_file="$1"
  local output_file="$2"
  [[ -s "$log_file" ]] || return 0
  if ! node "$ROOT/scripts/agent-log.mjs" result "$log_file" "$AGENT" >"$output_file.tmp" 2>/dev/null; then
    rm -f "$output_file.tmp"
    cp "$log_file" "$output_file"
    return 0
  fi
  mv "$output_file.tmp" "$output_file"
}

run_agent_exec_prompt() {
  local prompt_file="$1"
  local output_file="$2"
  local log_file="$3"
  local phase="${4:-exec}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: $AGENT exec using prompt $(basename "$prompt_file")"
    return
  fi

  if [[ "$AGENT" == "codex" ]]; then
    "${AGENT_EXEC_ARGS[@]}" -o "$output_file" - <"$prompt_file" 2>&1 | tee "$log_file"
  else
    "${AGENT_EXEC_ARGS[@]}" <"$prompt_file" 2>&1 | tee "$log_file"
    extract_claude_result "$log_file" "$output_file"
  fi

  record_tokens_used "$phase" "$log_file"
  detect_rate_limit "$log_file" "$phase"
}

run_agent_review_prompt() {
  local prompt_file="$1"
  local output_file="$2"
  local log_file="$3"
  local phase="${4:-review}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: $AGENT read-only review using prompt $(basename "$prompt_file")"
    return
  fi

  if [[ "$AGENT" == "codex" ]]; then
    "${AGENT_REVIEW_ARGS[@]}" -o "$output_file" - <"$prompt_file" 2>&1 | tee "$log_file"
  else
    "${AGENT_REVIEW_ARGS[@]}" <"$prompt_file" 2>&1 | tee "$log_file"
    extract_claude_result "$log_file" "$output_file"
  fi

  record_tokens_used "$phase" "$log_file"
  detect_rate_limit "$log_file" "$phase"

  [[ -s "$output_file" ]] || die "Review output was not written to $output_file"
}

run_implementation_phase() {
  local prompt_file="$RUN_DIR/implement.prompt.md"
  write_implementation_prompt "$prompt_file"
  note "Running implementation phase for $TASK_ID"
  run_agent_exec_prompt "$prompt_file" "$RUN_DIR/implement.out.md" "$RUN_DIR/implement.log" "implement"
}

run_review_phase() {
  local prompt_file="$RUN_DIR/review.prompt.md"
  local output_file="$RUN_DIR/review.out.md"
  write_review_prompt "$prompt_file"
  note "Running self-review phase for $TASK_ID"
  rm -f "$output_file"
  run_agent_review_prompt "$prompt_file" "$output_file" "$RUN_DIR/review.log" "review"
}

DEV_SERVER_PID=""

extract_port_from_url() {
  # Extracts the port from URLs like http://localhost:3000 or http://host:8080/path
  # Falls back to 3000 (Next.js default) if no port is present.
  local url="$1"
  local port
  port="$(printf '%s' "$url" | sed -nE 's#^[^/]*//[^:/]+:([0-9]+).*#\1#p')"
  [[ -n "$port" ]] || port=3000
  printf '%s' "$port"
}

start_dev_server() {
  local url="${DEV_SERVER_URL:-http://localhost:3000}"
  local timeout="${DEV_SERVER_READY_TIMEOUT:-60}"
  local port
  port="$(extract_port_from_url "$url")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: would start npm run dev on port $port and poll $url"
    return 0
  fi

  # Reject if something is already listening on the target port. Auto-falling
  # back to another port would quietly audit whatever that other service is
  # serving (or allow our dev server to land somewhere unexpected).
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port $port is already in use. Stop the conflicting service or set DEV_SERVER_URL to a free port (e.g. DEV_SERVER_URL=http://localhost:3100)."
  fi

  note "Starting dev server on port $port (npm run dev); logs: $RUN_DIR/dev-server.log"
  # Pass PORT explicitly so Next.js cannot silently shift to a fallback port.
  ( cd "$ROOT" && PORT="$port" npm run dev >"$RUN_DIR/dev-server.log" 2>&1 ) &
  DEV_SERVER_PID=$!

  local waited=0
  while (( waited < timeout )); do
    if curl -sf -o /dev/null --max-time 2 "$url"; then
      note "Dev server ready at $url"
      return 0
    fi
    if ! kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
      die "Dev server exited before becoming ready; see $RUN_DIR/dev-server.log"
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done

  die "Dev server did not respond at $url within ${timeout}s; see $RUN_DIR/dev-server.log"
}

stop_dev_server() {
  if [[ -n "$DEV_SERVER_PID" ]]; then
    note "Stopping dev server (PID $DEV_SERVER_PID)"
    pkill -P "$DEV_SERVER_PID" 2>/dev/null || true
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
    DEV_SERVER_PID=""
  fi
}

run_agent_review_ui_prompt() {
  local prompt_file="$1"
  local output_file="$2"
  local log_file="$3"
  local phase="${4:-review-ui}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: $AGENT UI review using prompt $(basename "$prompt_file")"
    return
  fi

  if [[ "$AGENT" == "codex" ]]; then
    "${AGENT_REVIEW_UI_ARGS[@]}" -o "$output_file" - <"$prompt_file" 2>&1 | tee "$log_file"
  else
    "${AGENT_REVIEW_UI_ARGS[@]}" <"$prompt_file" 2>&1 | tee "$log_file"
    extract_claude_result "$log_file" "$output_file"
  fi

  record_tokens_used "$phase" "$log_file"
  detect_rate_limit "$log_file" "$phase"

  [[ -s "$output_file" ]] || die "Review output was not written to $output_file"
}

run_review_ui_phase() {
  local dev_url="${DEV_SERVER_URL:-http://localhost:3000}"
  local prompt_file="$RUN_DIR/review-ui.prompt.md"
  local output_file="$RUN_DIR/review-ui.out.md"

  if [[ "$AGENT" == "codex" ]]; then
    note "Note: --agent codex does not have Playwright; UI review will rely on the prompt only."
  fi

  trap 'stop_dev_server' EXIT INT TERM
  start_dev_server

  write_review_ui_prompt "$prompt_file" "$dev_url"
  note "Running UI review phase for $TASK_ID"
  rm -f "$output_file"
  run_agent_review_ui_prompt "$prompt_file" "$output_file" "$RUN_DIR/review-ui.log" "review-ui"

  stop_dev_server
  trap - EXIT INT TERM
}

run_fix_phase() {
  local review_file="$1"
  local prompt_file="$RUN_DIR/fix.prompt.md"
  write_fix_prompt "$prompt_file" "$review_file"
  note "Running fix phase for $TASK_ID"
  run_agent_exec_prompt "$prompt_file" "$RUN_DIR/fix.out.md" "$RUN_DIR/fix.log" "fix"
}

run_review_fix_loop() {
  local pass=1
  while (( pass <= MAX_REVIEW_PASSES )); do
    note "Review pass $pass of $MAX_REVIEW_PASSES"
    run_review_phase

    if review_is_clean "$RUN_DIR/review.out.md"; then
      note "No review findings remain."
      return 0
    fi

    if (( pass == MAX_REVIEW_PASSES )); then
      note "Review findings remain after $MAX_REVIEW_PASSES passes."
      return 1
    fi

    run_fix_phase "$RUN_DIR/review.out.md"
    ((pass++))
  done

  return 1
}

run_local_preflight() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: ./scripts/preflight.sh"
    return
  fi
  ./scripts/preflight.sh
}

prepare_pr_body() {
  local seed_file="$RUN_DIR/pr-seed.md"
  local prompt_file="$RUN_DIR/pr.prompt.md"
  local output_file="$RUN_DIR/pr-body.md"

  note "Generating PR body seed"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: ./scripts/prepare_pr.sh $BASE_BRANCH $PLAN_REL > $seed_file"
    cat >"$seed_file" <<EOF
## Summary

- TODO

## Plan

- ${PLAN_REL}

## Validation

- [x] \`./scripts/preflight.sh\`

## Review Loop

- [x] Self-review completed
- [ ] Independent review findings addressed
- [ ] \`agent/automerge\` will only be added when the PR is ready

## Risks

- TODO

## Follow-Ups

- TODO
EOF
  else
    ./scripts/prepare_pr.sh "$BASE_BRANCH" "$PLAN_REL" >"$seed_file"
  fi

  write_prepare_pr_prompt "$prompt_file" "${seed_file}"
  note "Running PR preparation phase for $TASK_ID"
  run_agent_exec_prompt "$prompt_file" "$output_file" "$RUN_DIR/pr.log" "prepare-pr"
}

commit_if_needed() {
  if ! has_uncommitted_changes; then
    note "No uncommitted changes to commit."
    return
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: git add -A && git commit -m \"$COMMIT_TITLE\""
    return
  fi

  git add -A
  if git diff --cached --quiet; then
    note "No staged changes to commit."
    return
  fi

  git commit -m "$COMMIT_TITLE"
}

ensure_pull_request() {
  local current_branch pr_body_file pr_number
  current_branch="$(git branch --show-current)"
  pr_body_file="$RUN_DIR/pr-body.md"

  [[ "$LOCAL_ONLY" -eq 0 ]] || {
    note "Skipping push and PR creation in local-only mode."
    return
  }

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: git push -u origin $current_branch"
    note "DRY RUN: gh pr create/edit for branch $current_branch"
    return
  fi

  git push -u origin "$current_branch"

  if gh pr view --json number >/dev/null 2>&1; then
    pr_number="$(gh pr view --json number --jq '.number')"
    note "Updating existing PR #$pr_number"
    gh pr edit "$pr_number" --title "$PR_TITLE" --body-file "$pr_body_file"
  else
    note "Creating pull request for $current_branch"
    gh pr create --base "$BASE_BRANCH" --head "$current_branch" --title "$PR_TITLE" --body-file "$pr_body_file"
  fi
}

current_pr_number() {
  gh pr view --json number --jq '.number'
}

ensure_automerge_label() {
  # Create the agent/automerge label idempotently so a fresh clone of the
  # template doesn't require a separate bootstrap step.
  if gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null | grep -Fxq "agent/automerge"; then
    return 0
  fi
  note "Creating missing agent/automerge label"
  gh label create agent/automerge --color 0E8A16 \
    --description "Agent may enable auto-merge when PR is ready" >/dev/null 2>&1 || true
}

wait_for_pr_checks() {
  local pr_number="$1"
  local max_wait="${MERGE_CHECK_WAIT_SECONDS:-900}"
  local interval=10
  local waited=0
  local failed pending successful

  # Evaluate CI via `gh pr view --json statusCheckRollup` and filter out the
  # Agent Auto-Merge workflow itself. Rationale:
  # - `gh pr checks --required` errors out (exit 1) when branch protection has
  #   no required contexts configured — conflates "not configured" with
  #   "failures" and skips the wait.
  # - `gh pr checks` (no filter) returns all checks, including any stale or
  #   in-progress runs of the Agent Auto-Merge workflow itself (triggered by a
  #   prior merge-check attempt that labeled the PR). That would make us wait
  #   on our own orchestration.
  note "Waiting up to ${max_wait}s for CI checks on PR #${pr_number}"
  while (( waited < max_wait )); do
    failed="$(gh pr view "$pr_number" --json statusCheckRollup \
      --jq '[.statusCheckRollup[]
        | select((.workflowName // "") != "Agent Auto-Merge")
        | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT"
                 or .conclusion=="CANCELLED" or .conclusion=="STARTUP_FAILURE"
                 or .conclusion=="ACTION_REQUIRED" or .conclusion=="STALE")]
        | length' 2>/dev/null || echo 0)"
    pending="$(gh pr view "$pr_number" --json statusCheckRollup \
      --jq '[.statusCheckRollup[]
        | select((.workflowName // "") != "Agent Auto-Merge")
        | select(.status=="IN_PROGRESS" or .status=="QUEUED"
                 or .status=="PENDING" or .status=="WAITING"
                 or .status=="REQUESTED")]
        | length' 2>/dev/null || echo 0)"
    successful="$(gh pr view "$pr_number" --json statusCheckRollup \
      --jq '[.statusCheckRollup[]
        | select((.workflowName // "") != "Agent Auto-Merge")
        | select(.conclusion=="SUCCESS")]
        | length' 2>/dev/null || echo 0)"

    if (( failed > 0 )); then
      note "CI checks reported failures; proceeding to review"
      return 0
    fi
    if (( pending == 0 )) && (( successful > 0 )); then
      note "CI checks are green"
      return 0
    fi
    if (( pending == 0 )) && (( successful == 0 )); then
      note "No CI checks found on PR #${pr_number}; proceeding to review"
      return 0
    fi

    sleep "$interval"
    waited=$(( waited + interval ))
  done

  note "Timed out waiting for checks after ${max_wait}s; proceeding to review"
  return 0
}

run_e2e_verify_phase() {
  local out_dir log_file summary_file sentinel="E2E verification passed."
  out_dir="$RUN_DIR/e2e-verify"
  log_file="$RUN_DIR/e2e-verify.log"
  summary_file="$RUN_DIR/e2e-verify.out.md"
  mkdir -p "$out_dir"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: ./scripts/e2e.sh"
    printf '%s\n' "$sentinel" >"$summary_file"
    return 0
  fi

  # Graceful-fail contract: e2e-verify requires a top-level `npm run e2e`
  # script that runs a browser test suite. Missing this is a scaffold-
  # level gap, not a plan-level bug — fail fast with an actionable
  # pointer instead of letting the raw `npm error Missing script: "e2e"`
  # look like a test failure to the operator and the merge-checker.
  if ! ( cd "$ROOT" && npm run --silent --if-present e2e >/dev/null 2>&1 ); then
    if ! ( cd "$ROOT" && npm pkg get scripts.e2e 2>/dev/null | grep -q -v '^{}$' ); then
      {
        echo "E2E verification failed."
        echo ""
        echo "Scaffold gap: no \`e2e\` script in package.json."
        echo ""
        echo "The e2e-verify phase expects \`npm run e2e\` to run a browser test"
        echo "suite (typically Playwright). This is a project-shaped scaffold"
        echo "requirement, not a plan-level concern — see CUSTOMIZE.md in the"
        echo "Fork-and-Go harness docs for the minimal setup, or run"
        echo "\`./scripts/bootstrap-e2e.sh\` if the harness provides it."
        echo ""
        echo "To opt a specific non-UI-touching plan out of e2e-verify, invoke"
        echo "with --skip-e2e."
      } >"$summary_file"
      note "E2E verification failed — missing \`npm run e2e\` script; see $summary_file"
      return 1
    fi
  fi

  note "Running e2e-verify phase (npm run e2e); log: $log_file"
  local exit_code=0
  ( cd "$ROOT" && npm run e2e ) >"$log_file" 2>&1 || exit_code=$?

  # Preserve the Playwright HTML report and any failure screenshots alongside
  # the run's other artifacts so merge-readiness + CI reviewers can inspect
  # them without hunting through apps/web.
  # `--phase all` calls run_e2e_verify_phase twice against the same RUN_DIR
  # (once after prepare-pr, once inside merge-check). Clear the destination
  # first so `cp -R` doesn't nest into an existing directory on the second run.
  if [[ -d "$ROOT/apps/web/playwright-report" ]]; then
    rm -rf "$out_dir/playwright-report"
    cp -R "$ROOT/apps/web/playwright-report" "$out_dir/playwright-report" || true
  fi
  if [[ -d "$ROOT/apps/web/test-results" ]]; then
    rm -rf "$out_dir/test-results"
    cp -R "$ROOT/apps/web/test-results" "$out_dir/test-results" || true
  fi

  if (( exit_code == 0 )); then
    {
      printf '%s\n\n' "$sentinel"
      echo "Artifacts: $out_dir"
    } >"$summary_file"
    note "E2E verification passed."
  else
    {
      echo "E2E verification failed."
      echo ""
      echo "Exit code: $exit_code"
      echo "Full log: $log_file"
      echo "Artifacts: $out_dir"
      echo ""
      echo "Last 80 lines of the log:"
      echo '```'
      tail -n 80 "$log_file" 2>/dev/null || true
      echo '```'
    } >"$summary_file"
    note "E2E verification failed. See $summary_file and $log_file"
  fi

  return "$exit_code"
}

run_merge_check_phase() {
  local pr_number prompt_file output_file

  [[ "$LOCAL_ONLY" -eq 0 ]] || {
    note "Skipping merge readiness in local-only mode."
    return
  }

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY RUN: would run e2e-verify, merge-readiness review, and enable auto-merge when ready."
    return
  fi

  pr_number="$(current_pr_number)"
  wait_for_pr_checks "$pr_number"

  # Own the e2e-verify output in this phase's RUN_DIR. The `all` dispatch
  # also runs e2e-verify earlier to fail fast after prepare-pr; running it
  # again here makes the gate self-sufficient when merge-check is invoked
  # standalone, and immune to `latest` symlink churn from sibling runs.
  if (( SKIP_E2E == 1 )); then
    note "--skip-e2e set; skipping e2e-verify inside merge-check (opt-in for non-UI-touching plans)."
  else
    if ! run_e2e_verify_phase; then
      die "E2E verification failed in merge-check. Inspect $RUN_DIR/e2e-verify.out.md. Refusing to proceed to merge-readiness review."
    fi
  fi

  prompt_file="$RUN_DIR/merge.prompt.md"
  output_file="$RUN_DIR/merge.out.md"
  write_merge_prompt "$prompt_file" "$pr_number"

  note "Running merge-readiness review for PR #$pr_number"
  run_agent_review_prompt "$prompt_file" "$output_file" "$RUN_DIR/merge.log" "merge-check"

  if merge_is_ready "$output_file"; then
    note "Merge readiness is green. Labeling PR and enabling merge flow."
    ensure_automerge_label
    gh pr edit "$pr_number" --add-label agent/automerge
    ./scripts/enable_automerge.sh "$pr_number"
  else
    note "Merge readiness reported findings. Inspect $output_file"
  fi
}

if [[ "$PHASE" == "all" || "$PHASE" == "implement" || "$PHASE" == "prepare-pr" || "$PHASE" == "merge-check" ]]; then
  ensure_task_branch
fi

case "$PHASE" in
  implement)
    run_implementation_phase
    ;;
  review)
    run_review_phase
    ;;
  review-ui)
    run_review_ui_phase
    ;;
  fix)
    run_review_phase
    if review_is_clean "$RUN_DIR/review.out.md"; then
      note "No findings to fix."
    else
      run_fix_phase "$RUN_DIR/review.out.md"
    fi
    ;;
  prepare-pr)
    run_local_preflight
    prepare_pr_body
    commit_if_needed
    ensure_pull_request
    ;;
  e2e-verify)
    run_e2e_verify_phase
    ;;
  merge-check)
    run_merge_check_phase
    ;;
  all)
    run_implementation_phase
    if ! run_review_fix_loop; then
      die "Review loop did not converge. Inspect $RUN_DIR/review.out.md"
    fi
    run_local_preflight
    if ! has_uncommitted_changes && ! has_diff_against_base; then
      die "No changes detected for $TASK_ID after implementation."
    fi
    prepare_pr_body
    commit_if_needed
    ensure_pull_request
    if (( SKIP_E2E == 1 )); then
      note "--skip-e2e set; skipping e2e-verify phase (opt-in for non-UI-touching plans)."
    else
      if ! run_e2e_verify_phase; then
        die "E2E verification failed. Inspect $RUN_DIR/e2e-verify.out.md. Refusing to label the PR for auto-merge."
      fi
    fi
    run_merge_check_phase
    ;;
esac

note "Task run finished. Artifacts: $RUN_DIR"
