# Harness Engineering — What We're Learning

This is a living record of what we discover while running the agent-first
harness on this repo. It doubles as source material for a future blog post
and as a reference for anyone forking the harness to a new project.

**Maintenance convention.** After each exec plan merges to `main`, append an
entry to the _"Lessons by plan"_ section below: one short paragraph describing
what the plan taught us that wasn't obvious going in, plus the specific code /
convention change it produced. Periodically distill repeat patterns into
_"Meta-lessons"_. Before starting a new plan family (Authoring, Runtime,
Billing), re-read this doc.

---

## The north star

The long-running goal for this harness is **fork-and-go autonomy**: a
contributor hands the system a high-level product spec, and the harness
plans, implements, verifies, and ships the product with a human in the
loop only where a human adds real value.

The vision is explicitly **minimal-human, not zero-human.** There are
three roles a human still owns in the target state:

1. **Context provider.** The agent gets its knowledge from the repo. Any
   context that lives outside the repo — a Slack thread where the VP
   said "we can't charge over $X," an email from legal about data
   retention, a Jira comment with a customer pain point — has to flow
   into the agent's working context. The harness must accept this kind
   of free-form human-supplied context and route it to the right plan or
   the planner agent. Expected channels: a `docs/context/` drop folder,
   a `/context` runner phase that reads a chat log or email thread, or
   a structured "ask for context" block the agent can emit when stuck.

2. **Tool unblocker.** The agent can't complete OAuth consent screens,
   accept real money, revoke a live grant at a third party, or sign
   binding legal terms. When it needs one of those, it pauses and emits
   a concise "I need X to continue" artifact. The human grants the
   scope — an API key, an OAuth client, an SMS verification — and
   resumes the run. Target: these pauses are measured in minutes of
   human time, not hours.

3. **Clarifier and tie-breaker.** When a plan genuinely requires
   judgment the spec cannot answer — "should this be $49 or $69?",
   "which vertical ships first?", "brand: editorial or playful?" — the
   agent asks a specific, well-framed question and waits for a decision.
   The harness must distinguish real judgment calls (raise) from things
   the agent can decide itself (don't interrupt the human).

What the human does **not** do in the target state: write code, write
tests, configure scripts, debug flaky CI, chase down merge conflicts,
tune review prompts, edit plans for mechanical reasons. Those are the
agent's job. The measurable outcome: **the agent can work for 10+ hours
without human intervention** on a well-specified product.

## Capability gap (target state vs. today)

Today's harness takes a detailed, human-written plan and executes it
autonomously through merge. The target takes a product spec and
generates all the plans itself. Five net-new capabilities separate the
two:

| Capability                               | Today                       | Target                                                                                                                                                                         |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Planner agent** (spec → plan sequence) | Human writes plans          | An agent ingests a spec + existing code and emits a plan graph with dependencies, priorities, and cost estimates.                                                              |
| **Dependency resolution**                | Human sequences plans       | Machine-readable `depends_on:` in plan frontmatter; a resolver picks the next eligible plan at merge time.                                                                     |
| **Orchestrator / scheduler**             | Human invokes `run_task.sh` | A long-lived watcher (scheduled job or daemon) that triggers `run_task.sh` on every merge until the plan graph is empty. Has pause / resume / stop controls.                   |
| **Context ingestion**                    | Everything in-repo          | A drop folder, a runner phase, or an interactive "ask for context" block that lets the human paste Slack / email / wiki text into the agent's working set.                     |
| **Spec-fidelity verification**           | Implicit                    | After every N plans, the system re-reads the product spec and checks whether what's been built matches what was intended. Drifts trigger re-planning, not silent continuation. |

Plus two cross-cutting concerns:

- **Budget governance.** Per-product token ceiling, back-pressure on
  repeat failures, alerting when approaching limits, a "freeze" mode
  that pauses new runs pending human input. Without this, pathological
  loops can burn real money.
- **Top-level acceptance criteria.** The product spec must declare
  measurable release criteria the e2e-verify harness can actually run.
  "The product is done when every top-level criterion passes" is the
  stopping condition; without it, the loop has no idea when to announce
  a release candidate.

## The 10-hour unattended-run requirement

For the harness to actually deliver on "10 hours without a human,"
a handful of runtime properties have to hold:

- **State persistence** — the plan graph, per-plan status, accumulated
  budget, and outstanding human-unblock requests all live on disk and
  survive a runner restart.
- **Checkpointed long plans** — individual runs that span many Claude
  conversations (implement + N fix passes + e2e + merge-check) need
  intermediate saves so a mid-run crash doesn't discard hours of work.
- **Transient-failure resilience** — network blips, API timeouts, CI
  flakes all get retried with backoff rather than failing the run.
- **Observable from outside** — a human checking in at hour 7 can see,
  in under a minute, what's merged, what's running, what's blocked,
  and on what.
- **Clear idle vs stuck distinction** — a planner waiting on human
  context is not the same as a planner looping on a bad plan. The
  harness must distinguish these and surface only the former.

## Roadmap toward the target

The concrete plan sequence to reach the north star, sized similarly
to plans you've already run:

- **0034** Formalize plan schema + dependency graph. `depends_on:`
  frontmatter, resolver that picks the next eligible plan, a
  `plan-manifest.md` index.
- **0035** Planner agent: spec decomposer. Takes a product spec
  (free-form or structured) and emits an ordered plan sequence in the
  established shape. Idempotent on re-run.
- **0036** Orchestrator / watcher. A scheduled job or daemon that
  polls for merges, resolves the next eligible plan, and invokes
  `run_task.sh`. Pause / resume / stop controls. Observable.
- **0037** Context ingestion. `docs/context/` drop folder + a
  runner phase that pulls fresh context into the planner's working
  set before a plan runs. Support free-form paste and structured
  sources (email, Slack export).
- **0038** Budget + rate-limit governance. Per-product token
  ceiling; per-plan cost tracking; cool-downs on repeat failures;
  alert and freeze modes.
- **0039** Spec-fidelity checker. After every N plans merge,
  audit the product-as-built against the product-as-specified. Emit
  a drift report; trigger re-planning or human clarification when
  drift exceeds threshold.
- **0040** Top-level acceptance criteria + release gate. Define what
  "release candidate" means for a spec; extend e2e-verify to run the
  full top-level suite; emit a release-candidate announcement.

Each of those is roughly the size of 0032 or 0007. Expect the set to
land over the 30–60 plan range, alongside product work that validates
the meta-layer is working.

Once it's done, the harness's own README changes from _"run
`./scripts/run_task.sh <plan-id>`"_ to _"write your spec, then run
`./scripts/ship-it.sh`."_

---

## What harness engineering actually is

Harness engineering is the practice of building the scaffolding — plan
templates, prompts, review gates, mechanical checks, docs-as-contract —
that lets a coding agent ship substantial work without a human keystroke
in the loop for routine cases, and with the right human keystroke at the
right moment when judgment is required.

The _agent_ is not the product. The _harness_ is the product. Any reasonably
capable model can write the code; what separates a working autonomy loop
from a flaky one is the scaffolding around the code. That scaffolding is
what this document is about.

Three foundational claims we're testing:

1. **The repo is the system of record.** If a decision only exists in chat,
   it does not exist. Plans, prompts, prompts-about-prompts, and quality
   scores all live in version control.
2. **Every phase is a separate role.** Implementation agent, review agent,
   merge-readiness agent, and (eventually) e2e-verification agent all read
   different prompts, see different context, and produce different outputs.
   Role separation is where quality comes from.
3. **Friction belongs in mechanical checks.** Every piece of advice you find
   yourself giving twice should become a lint, a test, a validator, or a
   runner guard. Repeated human corrections are a harness failure.

---

## The loop

```
         ┌───────── plan (docs/exec-plans/active/NNNN-*.md) ─────────┐
         │                                                            │
         ▼                                                            │
   ┌──────────┐      ┌────────┐      ┌─────┐      ┌────────────┐      │
   │implement │─────▶│ review │─────▶│ fix │─────▶│  preflight │──┐   │
   └──────────┘      └────────┘ ◀────┴─────┘      └────────────┘  │   │
        ▲                 │  "No blocking findings."                │   │
        │                 └─converges on ─┐                         │   │
        │                                 ▼                         ▼   │
        │                          ┌─────────────┐         ┌──────────────┐
        │                          │ prepare-pr  │────────▶│   open PR    │
        │                          └─────────────┘         └──────────────┘
        │                                                         │
        │                                                         ▼
        │                                              ┌────────────────────┐
        │                                              │ wait for CI green  │
        │                                              └────────────────────┘
        │                                                         │
        │                                                         ▼
        │                                              ┌────────────────────┐
        │                                              │  e2e-verify (0032) │
        │                                              └────────────────────┘
        │                                                         │
        │                                                         ▼
        │                                              ┌────────────────────┐
        └───────────── re-plan if blocked ─────────────│ merge-readiness    │
                                                       │ (material gates)   │
                                                       └────────────────────┘
                                                                  │
                                                                  ▼
                                                          label + auto-merge
```

Four orchestrator entry points: `--phase all`, `--phase implement`,
`--phase review`, `--phase fix`, `--phase review-ui`, `--phase prepare-pr`,
`--phase e2e-verify`, `--phase merge-check`. The `all` phase chains them;
the others exist so a human can recover from any mid-loop failure without
restarting the whole thing.

---

## Primitives that earned their place

These are the non-obvious mechanics that turned out to matter. Each one
exists because the naïve version didn't work.

### Severity tiers with a convergence sentinel

Reviewers will find _something_ on every pass if the bar is "anything
imperfect." Without a severity floor, the review loop never converges on
non-trivial plans — each fix pass clears the current findings and exposes
the next tier of smaller ones.

The fix: four-tier severity (`Critical`, `High`, `Medium`, `Low`), and
two convergence signals — `No findings.` or `No blocking findings.`. Low
findings are reported but not blocking; they land in the PR body or the
tech-debt tracker as follow-ups.

Landed in `2f6d681`.

### Pass budget that scales with surface area

UI plans converge in 1–2 review passes. Connector plans (Gmail, OAuth,
any security-sensitive branch) need 4–6. A fixed 3-pass budget was too
tight for connectors and too loose for UI.

Default bumped 3 → 5 in `3c507f8`. The override flag exists for both
directions. Empirical rule so far: UI plans 1–3 passes, connector plans
4–6, runtime/state-machine plans 3–5.

### The reviewer must not hold its own outputs hostage

Auto-merge workflows that listen for `pull_request_target: labeled` and
then call `gh pr checks` end up seeing themselves as an in-progress check,
report "CI pending," and defer forever. This is the classic self-reference
race.

Fixed in `638b37f`: both `wait_for_pr_checks` (runner) and
`enable_automerge.sh` evaluate the status-check rollup and explicitly
filter out the `Agent Auto-Merge` workflow name before counting.

### First-line sentinels with defensive matching

`review_is_clean` originally checked only the first non-empty line for
`No findings.` or `No blocking findings.`. On 0004 the reviewer emitted
a preamble paragraph before the sentinel and the entire run failed despite
material convergence.

Fixed in `28ee9b7`: keep the fast first-line check, but fall back to a
regex that matches the sentinel as a standalone line anywhere in the
file. Parser is strict about format but forgiving about placement.

### Locked Decisions as plan amendments, not silent drift

On 0007 the agent chose to implement Gmail OAuth against raw HTTPS
endpoints instead of `google-auth-library` (the reason was sound — smaller
bundle, simpler cassettes). But the Locked Decisions section of the plan
still named the library. Reviewer correctly flagged this as plan drift.

The right fix was _not_ to refactor the code; it was to amend the plan's
Locked Decisions with a dated entry explaining the drift. Plans are
contracts that can be re-negotiated, but re-negotiation has to be visible.

### Preamble-free PR bodies

The `prepare-pr` phase initially allowed the agent to emit a sentence of
meta-commentary ("Now I have everything needed to fill in the PR body
per the plan's...") before the `## Summary` heading. Merge-readiness
flagged it. The fix was a terser output rule: _"first line of your response
must be `## Summary` — no preamble, no code fences, no paragraphs."_

Landed in `2f6d681`. Generalises: every prompt that produces a structured
artifact should specify the exact first line and forbid preamble.

### Merge-readiness gates on material state, not checkbox choreography

The PR template has a "Review Loop" section with checkboxes. The review
agent and the merge-readiness agent kept dinging each other about the
checkbox state — even though the checkboxes are generated by the runner,
not meaningful state. Rewrote the merge-readiness prompt to gate on
material conditions only: draft flag, CI status, diff severity, PR body
structure. Checkboxes are informational.

### `.env*` gitignored by pattern with a template exception

`apps/.env.local` was one `git add -A` away from being committed before
the runner's clean-tree guard caught it. `.gitignore` now covers `.env*`
with a `!.env.example` exception. This is the defensive layer; the clean-tree
guard is the primary safety.

Landed in `4a880e2`.

### Doctor script as the single local sanity check

Repeated "what's wrong with my env?" questions are a harness failure.
`scripts/doctor.sh` reads `.env`, checks every required variable, hits
Postgres with `pg_isready`, inspects the docker container, and reports
one line per check. Operators run it; they don't debug piecemeal.

Landed in 0030 (`6b8539a`).

### Env loading reality must match docs

0030 shipped `.env.example` at the repo root and told the operator
`cp .env.example .env` — but Next.js reads env only from the app dir,
and CLI scripts read nothing. The documented flow was false on every
dimension except `doctor.sh` (which happened to match).

Fixed in 0031: `dotenv-cli` prefix on env-dependent root scripts,
`dotenv/config` preload in `next.config.mjs`. Now the documented flow
and the implementation agree.

Generalises: documentation lies until proven; verify by running.

### Gates read invocation-local paths, not symlinks

`.task-runs/<id>/latest` is a convenience symlink to the most recent run.
0032 wired the merge-readiness gate to `.task-runs/<id>/latest/e2e-verify.out.md`
and the gate failed on its own PR: the implementation agent ran
`./scripts/run_task.sh 0032 --phase e2e-verify` two or three times to verify
the harness while implementing it (per the plan's own steps), each
sub-invocation moved `latest`, and by the time `--phase merge-check` ran the
symlink pointed at a sibling run's directory — not the main run's.

0033 fixed this in two places: (1) `run_merge_check_phase` now runs
`run_e2e_verify_phase` itself as its first step, so the gate's witness is
written into _this_ phase's `$RUN_DIR`; (2) `write_merge_prompt` templates
the explicit `.task-runs/<id>/<run-id>/e2e-verify.out.md` path into the
merge-readiness prompt, and `docs/prompts/merge-readiness.md` warns the
reviewer not to consult `latest/` at all. The `--phase all` dispatch keeps
its earlier `run_e2e_verify_phase` call so prepare-pr still fails fast on a
broken suite — both runs share the same `RUN_DIR` and write the same
sentinel, so the redundancy is free.

Generalises: any gate that reads from a mutable, shared path (symlink,
"latest" pointer, environment-scoped variable) is making a bet that no
sibling process has touched the path since the gate's producer wrote to it.
That bet is unsafe in any harness where agents compose runs.

### Propagate parser fixes across all sentinel parsers

`review_is_clean` got a defensive fallback in `28ee9b7` (0004) — tolerate
the sentinel appearing as a standalone line anywhere in the file, not
just the first non-empty line. The merge-readiness parser `merge_is_ready`
was not updated at the same time and kept the strict first-line check.

It bit 0008: the merge-readiness review correctly emitted
`No findings. Ready to enable auto-merge.` but led with a preamble bullet
summarising what it had verified. The parser read the bullet, missed the
sentinel, refused the merge. Same bug class, different parser, caught
six plans later.

Fix in `<commit-sha>`: `merge_is_ready` mirrors `review_is_clean`'s
pattern exactly — fast first-line check, fall back to a standalone-line
regex anywhere in the file. Both parsers now behave identically.

Generalises: when one parser gains defensive matching against model
drift, audit every sibling parser for the same problem class. One fix
that travels through the herd is usually cheaper than N fixes delivered
one at a time by reality.

### E2E verification is a phase, not a vibe

The reviewer _reads_ diffs. It does not _run_ the product. 0030's
`MissingSecret` error shipped through a clean merge-readiness because no
automated step had ever hit `/signin` in a browser with a populated env.

0032 adds an `e2e-verify` runner phase that boots the full stack against
a dedicated e2e database, runs a Playwright suite, and gates merge on
`E2E verification passed.`. It also closes the regression canary:
deliberately removing `AUTH_SECRET` from `.env.e2e` fails the
`signin.spec.ts` with a console-error assertion rather than a silent
timeout.

### E2E gate ≠ first-run readiness

The e2e-verify gate runs against `app_e2e` with its own bootstrap and
mocks every third-party OAuth. It proves behavior against a known-good
fixture; it does not prove that a fresh fork's _real_ environment is wired
up to ship. The 0012 post-landing UAT on 2026-04-20 — our first full
sign-in-to-save-an-agent run against a live Google OAuth app — exposed
three classes of failure that every prior e2e gate had passed cleanly:

- **Dev migrations drift.** Migration 0005 never ran against
  `app_dev`; `/app/agents` threw "relation agents does not exist" on
  first visit. The e2e harness's own `app_e2e` bootstrap had hidden
  the gap.
- **Silent connector catches.** The Gmail callback's `catch {}` block
  swallowed a Gmail-API-disabled 403 and redirected with a generic
  `profile_fetch_failed`. An operator had no way to distinguish "API
  disabled" from "token expired" without patching in a `console.error`.
  The same pattern existed in Calendar and HubSpot.
- **Empty-state funnels.** `/app/connections` only surfaced a
  `Connect Gmail` CTA in the zero-connections state — a fresh user had no
  path to Calendar or HubSpot before connecting Gmail first.

0034 closed each directly (a `predev` migration step, structured catches
with the same user-visible codes, three always-rendered connector cards)
and added `scripts/first-run-readiness.sh` as a standing probe: DB
reachability, every migration applied, every `.env.example` key
populated, required tables present, `AUTH_SECRET` length. The probe is
opt-in and non-mutating; it diagnoses, the operator acts.

Generalises: an automated gate that passes against mocks is a lower bar
than an automated probe that passes against the real environment. Ship
both. "Integration-readiness" — probing whether Gmail API / Calendar API
/ HubSpot scopes are enabled at the third party — is a separate harness
on top of this one, not a substitute.

---

## Lessons by plan

Append-only. One entry per merged plan. Keep to one paragraph plus a
one-line takeaway and the commit hash.

### 0001 Bootstrap agent-first workflow _(pre-existing)_

Starter scaffolding for the harness — `AGENTS.md`, `ARCHITECTURE.md`,
prompt templates, runner, preflight, PR template, validator, CI.

**Takeaway**: establish the repo-as-contract discipline before writing
any product code. — `25bd21b`

### 0002 Build landing page _(5ff84bf + favicon 03dbcfd)_

First real UI plan. Review-ui on the merged page found one low finding
(favicon 404) that the text review never could. The reviewer-as-code-reader
limitation showed up on our very first UI plan.

**Takeaway**: code review and UX review are different tools. Ship both.
— `5ff84bf`

### 0003 Capture waitlist signups _(fd744e1)_

Review loop wouldn't converge — each fix pass surfaced a new tier of
Low-severity items. Manually triaged: applied the mechanical fix,
documented the at-most-once tradeoff in the tech-debt tracker, opened
PR with the remaining items as known limitations.

**Takeaway**: severity tiers and the `No blocking findings.` sentinel
exist because of this plan. Without them the loop grinds on polish. —
`fd744e1`

### 0004 Establish auth and workspace tenancy _(81a114b)_

Substantial plan (Auth.js v5, Drizzle adapter, 6-table migration,
`packages/auth`, middleware, `/signin`). Review converged materially on
pass 3 but the parser missed the sentinel buried under a preamble
paragraph. First time the loop failed purely on a parser bug.

**Takeaway**: defensive matching in the convergence parser. Also: plans
that touch substantial new packages benefit from `Read-First Files`
listing every package they introduce. — `81a114b`

### 0005 Set up Postgres, migrations, secrets store _(d2307a7)_

First fully autonomous end-to-end run post convergence fixes. Zero
interventions. Gave us `docker-compose.dev.yml`, `packages/db`,
`packages/secrets`, the `migrate`/`generate`/`studio` scripts, and
`packages/secrets` envelope encryption.

**Takeaway**: when the loop works, it _really_ works. 5 phases executed,
~30 min, merged clean. — `d2307a7`

### 0006 Build authenticated app shell _(9d4b85c)_

UI plan. Review converged immediately (`No blocking findings.` on pass
1). Merge step stuck because `Agent Auto-Merge` was counted as a pending
check by `enable_automerge.sh` itself — the self-reference bug. Merged
manually; fixed the bug on main in the same hour.

**Takeaway**: auto-merge scripts must filter their own workflow from the
check rollup. — `9d4b85c`, fix `638b37f`

### 0029 Adopt distinctive typography and brand fonts _(071385d)_

Wrote the plan in response to the Anthropic frontend-aesthetics cookbook
analysis. Swapped Iowan Old Style / Helvetica / Arial for Fraunces +
IBM Plex Sans via `next/font`; rebased the type scale; consolidated hero
motion. Fully autonomous, two review passes.

**Takeaway**: when the plan is opinionated and the reviewer is strict,
brand polish can ship on the same loop as infrastructure work. No special
mode needed. — `071385d`

### 0007 Connect Gmail via OAuth _(2becfed)_

Hardest plan so far. Review loop exhausted 3-pass budget with legitimate
findings still present. Each subsequent manual fix cycle found a NEW
real Medium at the edges of the growing implementation (plan drift →
re-consent orphan → forbidden-banner dead code → partial-consent orphan
→ first-connect orphan paths). Converged on pass 6.

**Takeaway**: connector plans have more security-sensitive branches
than UI or data-layer plans. Bumped `--max-review-passes` default 3 → 5
after this. Also: orphan-grant class bugs can reappear in multiple
branches; the fix is usually structural (wrap post-exchange failures
in a revoke helper), not per-branch. — `2becfed`, budget bump `3c507f8`

### 0030 Connect landing CTAs and enable local dev _(6b8539a)_

Marketing CTA + operator enablement. Fully autonomous. Shipped
`.env.example`, `scripts/doctor.sh`, `docs/LOCAL_DEV.md`, docker port
`55432`, and the "Sign in / Get started" entry points on the landing
page. UAT failed afterward because the documented flow (`cp .env.example
.env` at repo root) did not actually load — the reviewer read the diff,
not the stack.

**Takeaway**: a reviewer who has never run the product cannot catch
configuration-integration bugs. This is the gap 0032 is designed to
close. — `6b8539a`

### 0031 Fix repo-root env loading _(9e2da7b)_

Smallest plan so far. 15 minutes of runner time, converged on pass 1
with `No findings.`, first-try. Added `dotenv-cli` wrapping to root
scripts and a `dotenv/config` preload in `next.config.mjs`.

**Takeaway**: the loop self-corrects when reasoned about. 0031 exists
because 0030's UAT failed; the harness produced the plan that fixed
its own gap. Compositional feedback works. — `9e2da7b`

### 0032 Build an E2E verification harness _(fe33123)_

Largest autonomy-bearing plan since 0007. Shipped an `e2e-verify`
runner phase, `apps/web/playwright.config.ts`, five baseline specs
(landing, signin, middleware, waitlist, no-regressions),
`scripts/e2e.sh` orchestrator, `.env.e2e.example`, a GitHub Actions
`e2e` workflow, and the merge-readiness gate update. Converged
`No blocking findings.` on pass 1. Then failed its own
merge-readiness gate because the Execution Steps instructed the agent
to run `--phase e2e-verify` separately to test the harness — each
sub-invocation moved `latest/`, and the gate's path assumption
(`.task-runs/<id>/latest/e2e-verify.out.md`) lost the sentinel.

**Takeaway**: the plan that closes UAT-blindness introduced a fresh
class of gate fragility on its own landing. The e2e _suite_ was green
locally and in CI; only the symlink-indirection gate failed. Merged
manually; 0033 landed the structural fix. — `fe33123`

### 0033 Harden the E2E-Verify Gate Against Symlink Churn _(ccc26cf)_

Two-line structural fix mirroring the 0030 → 0031 pattern.
`run_merge_check_phase` now runs `run_e2e_verify_phase` as its first
step, writing the sentinel to its own `$RUN_DIR`. `write_merge_prompt`
templates the absolute path into the merge-readiness prompt so the
reviewer cannot accidentally read `latest/`. The `all`-mode dispatch
still runs e2e-verify earlier so prepare-pr fails fast on a broken
suite — both runs share `$RUN_DIR` and write the same sentinel, so
the redundancy is free. Fully autonomous end-to-end; 2 review passes.

**Takeaway**: symlinks are mutable state. Gates should own the
artifact they gate on, or read from paths that cannot be moved by
sibling invocations. — `ccc26cf`

### 0020 Ship CRM Action Executor (HubSpot) _(2931b84)_

Third executor. 12 files, 1474 insertions. Converged on **review pass
2 of 8** — the cleanest executor run of the three. Shipped
`packages/executors/src/crm/executor.ts` with `crm.upsert_contact`
and `crm.add_note` actions, integration tests against a mocked
HubSpot API, and dispatcher wiring for the new action kinds.

**Takeaway**: once 0018 exercised the executor pattern through the
reviewer and 0019 confirmed the pattern held, 0020 landed with no
rescue. The rich-plan review burden is a per-plan concept, not a
per-category one: same executor shape, different reviewer pass
depth. — `2931b84`

### 0019 Ship Calendar Action Executor _(7dab8df)_

Second executor. 22 files, 2189 insertions. Shipped
`packages/executors/src/calendar/` with `calendar.propose_slots` and
`calendar.book_event` actions, working-hours-aware slot search,
integration tests, and dispatcher wiring. Converged on **review
pass 3 of 8** — `--max-review-passes 8` was carried from 0018's
rescue but wasn't needed here.

**Takeaway**: the bumped pass budget was cheap insurance. It cost
nothing when unused (convergence short-circuits) and would have
prevented 0018's rescue if it had been the default. Worth making
this a durable runner default once one more rich plan lands cleanly
with it. — `7dab8df`

### 0018 Ship Email Action Executor _(e87648d)_

First executor. 17 files, 1905 insertions. Shipped
`packages/executors/src/email/` with `email.draft_reply` and
`email.send` actions, rendering pipeline with merge-field
resolution (trigger / knowledge / runtime / action.mergeFields
precedence), error-kind mapping (401 → reauth-flip,
403 → permanent, 429 → rate-limited, 404 → not-found,
5xx → transient), and a three-phase idempotent executor that uses
`ctx.priorExternalId` to no-op on crash-resume. **First plan to
exhaust `MAX_REVIEW_PASSES=5` with every pass productive** (no
reviewer-vs-fixer ping-pong; each pass found new material).

**The 5-pass productive trajectory:**

- Pass 1: initial implementation findings (fixed)
- Pass 2: 403 error mapping diverged from plan (Medium; fixed)
- Pass 3: `findTemplateBody` silently drafted an empty body when
  `action.templateId` wasn't in `spec.knowledge` — the renderer
  would emit a blank reply into the user's Gmail thread with no
  error (Medium; fixed by returning `invalid_input`)
- Pass 4: `execute()` ignored `ctx.priorExternalId` — the runtime
  worker's three-phase commit _assumes_ executor idempotency, so a
  crash between the `dispatched` checkpoint and the audit write
  would send a duplicate email on resume (High; fixed by caching
  on `priorExternalId`). Also Medium: `email.send` branch error
  mapping uncovered (fixed with a dedicated send-path suite).
- Pass 5: one more Medium (`action.mergeFields` override untested),
  ceiling hit, loop exited non-zero.

**The rescue**: committed working-tree state, ran
`scripts/run_task_loop.sh 0018` (which runs a fresh review/fix
budget against the current disk state). Pass 1 closed the
mergeFields test, pass 2 returned `No blocking findings.` The
prepare-pr phase then failed on a **prettier non-idempotency bug**
in the HARNESS*ENGINEERING 0017 entry — a bare `MAX_REVIEW_PASSES`
identifier immediately adjacent to an `\_italic*`emphasis marker
triggered prettier's markdown pass to rewrite the file differently
on each`--write`invocation. Fixed by wrapping the identifier in
backticks and switching the emphasis to`**bold**`. 0018 merged as
PR #25.

**Takeaway — two harness primitives earned their place this run:**
(a) `scripts/run_task_loop.sh` (born from 0017's rescue) is the
right abstraction when a run has productive passes but hits the
ceiling; it picks up from disk state and gets a fresh pass budget.
(b) **Identifiers in log prose must be backticked, emphasis must
use `**bold**`not`*italic*`** — the prettier idempotency
requirement is non-obvious and can only be caught via CI, not via
human review. Mechanical rule added to the log conventions.
— `e87648d`

### 0017 Ship Runtime Worker and Queue _(0f6ba26)_

Third Runtime-phase plan and the first to break the
clean-pipeline streak at 10. Shipped `apps/worker/src/runtime-worker.ts`
(BullMQ-backed runtime worker), `packages/runtime/src/process-trigger.ts`
(trigger dispatch + policy evaluation + action execution + checkpoint
commit), `packages/runtime/src/runs.ts` (run + checkpoint repo), a DLQ
queue, concurrency gate, migration `0008_runs_and_checkpoints.sql`, and
— notably — `scripts/run_task_loop.sh` as a new harness primitive born
directly from this plan's own rescue. 22 files, 2994 insertions.

**Why the streak broke.** The first `run_task.sh 0017 --phase all`
invocation did implementation + pass 1 review (High + 3 Mediums,
all fixed cleanly, 502 tests green) and then hit Claude's usage
limit mid-pass-2 review. The runner has no rate-limit detection —
every subsequent phase just echoed `You've hit your limit · resets
9pm (America/Chicago)` to review.out.md and counted that as a
review pass. Passes 3–5 all failed the same way. The runner
exited with `Review findings remain after 5 passes.` — a
false-negative convergence failure caused by a _resource_
constraint, not a correctness one. Nothing was committed; the
branch had valid implementation + pass-1-fix output sitting in the
working tree with no PR.

**The rescue.** Rather than discard the ~30 min of pre-limit Claude
work, we (a) committed the uncommitted working-tree state to the
branch to preserve it, (b) used `run_task.sh --phase fix` (which
runs one review pass + optional fix) to drive pass 2 once the limit
reset, and (c) built `scripts/run_task_loop.sh` — a wrapper that
loops `--phase fix` with rate-limit detection and an explicit
resume hint, then calls `--phase prepare-pr` + `--phase merge-check`
when review converges. The loop's first invocation found a trivial
`set -u` empty-array bug (fixed on the same branch); the second
invocation converged on pass 1, prepared the PR, and landed
merge-check cleanly. Pass 2 fix had already closed the reviewer's
Critical (TerminalDispatchError retry bypass via BullMQ attempts:5 —
turning a terminal failure into 5 duplicate dispatches, duplicate
DLQ writes, duplicate audit events) + 3 Mediums (checkpoint/audit
atomicity, per-process concurrency documentation, missing BullMQ
glue tests — 9 new tests landed), so pass 3 had nothing to flag.
511 tests total.

**Takeaway — the resource-constraint class of failure.** Until
0017, every plan in this harness converged or diverged on its own
code-correctness. 0017 is the first time the harness failed for a
reason orthogonal to the plan's correctness: the model provider
rate-limited a long-running session. For the fork-and-go vision
("10-hour unattended run") this is the single most important class
of failure to handle, and the runner hadn't met it before.

The primitive `scripts/run_task_loop.sh` is the start of the
answer: detect the limit, exit cleanly with exit code 2 and a
resume command, never burn a review pass on an error message. Two
longer-term items this surfaced (roadmap, not immediate work):
(a) the main runner's review loop should itself detect the limit
and exit 2 the same way, so the operator doesn't have to wait for
`MAX_REVIEW_PASSES` to realize nothing is happening; (b) budget
governance (plan 0038 on the roadmap) should track per-plan
Claude-token consumption so the operator can see expected cost
before firing a plan. The rate-limit window is effectively a
"budget ceiling enforced by the provider, not by us" — building
our own ceiling means we know we're approaching it **before** the
provider cuts us off mid-review. — `0f6ba26`

### 0016 Build Policy Engine _(fffc35b)_

Second Runtime-phase plan. Shipped `packages/policy-engine` (pure
evaluator with red-line evaluation, policy-mode routing, graduation
tracking, quota gates) + `agent_graduation_state` migration + new
`sender_domain`/`recipient_domain` red-line kinds + regex-pattern
safety guards on the `regex_match` red-line. 22 files, 2070
insertions. **Took 4 review passes to converge — the longest yet —
and every pass closed a real safety bug.**

**Pass 1 Medium**: purity-guard tests omitted `graduation-core.ts`.
The engine's correctness rests on pure evaluation (same inputs →
same decision); a file sneaking in `Date.now()` or
`Math.random()` would break graduation determinism silently. Fix
extended the purity guard to enumerate every source file.

**Pass 2 Medium — silent red-line bypass**: `regex_match`
red-line validation called `new RegExp(value)` but only checked
the pattern, never the flags. `flags: z.string().max(8).optional()`
accepted arbitrary short strings (`"xyz"`, `"z"`). A malformed flag
string would cause `RegExp(pattern, flags)` to throw at evaluation
time, the engine's catch would swallow it, and the red-line with
`onMatch: "block"` would silently fail open — exactly the class
of silent-bypass the safety layer is designed to prevent. Fix added
a `/^[gimsuy]*$/` + no-repeat refinement on `flags` and a pattern
refinement that compiles with the declared flags.

**Pass 3 Medium — safety-critical validator shipped with no
rejection tests**: the new red-line schema refinements landed
without a test that exercised rejection of an invalid pattern, an
invalid flag set, or acceptance of a well-formed
`sender_domain`/`recipient_domain`. Comment in the source called
out exactly why the guard existed ("a typo like `[oops` would be
accepted here and silently treated as a non-match... letting a
block red-line slip through unnoticed"). Fix added the missing
tests — 478 total tests by end, up from 471.

**Pass 4**: `No blocking findings.`

**Takeaway**: **tenth consecutive clean-pipeline run**, and the
first that needed four review passes. For safety-layer code, that
is not a pipeline smell — it is the pipeline working. Each pass
caught a real bug the implementer had a plausible reason to miss
(purity file added later, regex flags edge case, new schema kinds
without tests). **When the plan's stakes are "silently fails open"
instead of "loudly fails closed," the reviewer budget has to allow
for multiple passes.** The `MAX_REVIEW_PASSES=5` ceiling earned
its number. — `fffc35b`

### 0015 Ship Trigger Engine (Polling-First) _(428aaa7)_

First Runtime-phase plan and the largest single landing so far: 38
files, 4564 insertions. Shipped `packages/runtime` (email / calendar /
scheduled pollers, watermark management, emitted-trigger dedupe repo,
cron parser, scheduler, entitlement checks, metrics, audit adapter)
and a new `apps/worker` scheduler process with `/metrics` and
`/healthz` HTTP endpoints. `packages/db/migrations/0006_trigger_engine.sql`
added `emitted_triggers`, `audit_events`, `workspace_entitlements`, and
watermark columns on `agents`. Converged on review pass 3 after two
substantive fix cycles.

**Review pass 1 High — reserved-before-enqueue drop window.**
Implementation reserved an `emitted_trigger` row, then called
`queue.enqueue`. If the enqueue threw — Redis outage, BullMQ schema
mismatch, any transient error — the reservation stayed, the watermark
still advanced, and the event was permanently lost. Exactly the class
of silent-drop the exactly-once invariant is supposed to prevent.
Fix: added `release(agentId, kind, externalId)` to `EmittedTriggerRepo`,
wrapped every `enqueue` call with try/catch that releases the
reservation and re-throws before the watermark advance. Pass 1 also
flagged **Medium** (Drizzle schema drift — migration had
check-constraints and indexes the TypeScript schema didn't mirror)
and 7 Lows; schema drift fixed, Lows deferred with written reasons.

**Review pass 2 Medium — email poll silently drops backlog.** Gmail's
`users.messages.list` returns newest-first with a 50-message page cap.
The implementer advanced the watermark to the newest message's date
without checking whether the cap was hit. On any backlog scenario —
scheduler outage catch-up, mailing-list burst, post-activation flood
— older unread messages beyond the page cap would be permanently
skipped because `since = newestMessageDate` the next tick. Silent
exactly-once-invariant violation. Fix: only advance the watermark
when `messages.length < cap`; otherwise the poll re-runs the same
window next tick until the backlog drains. Five Lows also flagged
(broken `./testing` export path, missing HTTP error listener, `NaN`
tick-ms on malformed env, dead calendar watermark write, unused
type); two closed in the same fix cycle, three deferred as explicitly
non-blocking.

**Takeaway**: **ninth consecutive clean-pipeline run**, and the
first plan that ships a long-running server process (the scheduler
worker). The two fix cycles both closed silent-delivery-loss bugs in
the polling layer — neither had unit-level coverage for the specific
failure mode, both were caught by the reviewer reading intent off
the plan's "exactly-once delivery" wording. Worth noting:
**correctness invariants stated in the plan are load-bearing** —
the reviewer used them as oracles to find real holes in the
implementation. The implementer's tests proved their own logic; the
reviewer tested the plan's invariants against that logic.
Runtime-phase opener landed in one pipeline run. — `428aaa7`

### 0014 Enable Natural-Language Spec Editing _(f904606)_

The first authoring plan that exercises the LLM endpoint on existing
data instead of a blank-slate interview. Shipped `/app/agents/:id/edit`
(input row + collapsible field-level diff + edit history with
Restore), a new `editDefinition` entry point in `packages/agent-authoring` that
turns a plain-language instruction into a structured edit against the
current definition, the `DefinitionDiff` data model + renderer in
`packages/agent-definition`, and `/api/agents/:id/edit` + `/api/agents/:id/restore`
routes that re-run guardrails and write a new `definition_versions`
row on approval. 24 files, 3832 insertions. Converged on review pass
3 after two substantive fix cycles.

**Review pass 1 Medium — Restore bypassed the authoring guardrail
pipeline.** The implementer's first cut had Restore POST the target
version's spec straight to `/api/agents/[id]/versions`, which only
runs the Zod schema. A prior version with weaker red-lines could be
re-installed in one click — exactly the bypass the guardrail was
written to prevent. Fix added `/api/agents/[id]/restore` that calls
`evaluateGuardrails` server-side with `before=current`, `after=target`,
and a deliberately bland synthetic operator utterance (`"restore to
vN"`) so consent-based guardrails can't be talked out of by the
synthesized wording. Two pass-1 Lows (pendingRestore state leaking
into the next typed edit, no UI tests for `SpecDiffView`/`EditSurface`)
also closed in the same fix cycle.

**Review pass 2 Medium — edit route 500'd on a partial draft.** The
patch validator accepts patches whose result has `trigger: null` or
`policy: null` as a "partial draft" so the model can ask a follow-up
question rather than hard-fail; the route then handed that partial
draft to `diffSpecs`, which immediately dereferenced `policy.mode`
and threw. The user would have seen a 500 instead of the inline
validation message the plan required. Fix returned nullable
`proposedSpec`/`diff` from the route and conditionally rendered the
diff. Three pass-2 Lows (diff-test combinatoric gaps, restore
utterance contract test, stale comment) all closed.

**Takeaway**: **eighth consecutive clean-pipeline run**. First plan
where every fix cycle closed a real correctness bug rather than a
stylistic finding — the reviewer caught a guardrail bypass and a
500-instead-of-validation-error in the same plan, both in code paths
that had unit tests but not the specific failing inputs. Worth
remembering: **route-level integration tests catch what
package-level unit tests miss**, and they're cheap to add. The
"shared interface, plug a new feature in" pattern paid a third time
(0012→0013→0014) — `editDefinition` reused 0013's guardrail/audit/repair
machinery without changes to either side. — `f904606`

### 0035 Swap authoring meta-agent to GPT-5.4 _(123a836)_

Provider swap: Anthropic (Claude Sonnet/Opus) → OpenAI (GPT-5.4-mini /
GPT-5.4) behind the same `ModelClient` interface 0013 shipped.
Contract, guardrails, audit events, repair loop, and feature flag are
unchanged — the client wiring and env vars are the only surface that
moved. `AUTHORING_MODEL` / `AUTHORING_REPAIR_MODEL` env overrides let
operators retune the tier without a code change. Converged on review
pass 3 after one substantive fix cycle.

**Review pass 1 Critical — every real OpenAI call would have 400'd.**
The implementer passed the turn-contract JSON Schema with
`response_format.strict: true` — but OpenAI's strict mode requires
`additionalProperties: false` on every object, every property key also
in `required`, and no open `{}` schemas. The inherited schema violated
all three. Stubbed tests passed (they don't call the SDK); the fault
would have surfaced only on the first real request. Fix: dropped
strict schema, switched to `{ type: "json_object" }`, and relied on
the existing `parseTurn` Zod validator as the integrity boundary.
Pass 2 was `No blocking findings.` with four Lows the fix agent
correctly declined to expand scope on.

**Takeaway**: when the provider leak is contained behind a narrow
interface (one file, one factory, no provider-typed fields upstream),
a product-direction swap is a one-PR move — **but stubbed tests can't
catch provider-side API contract violations.** The reviewer substituted
for the missing integration test and flagged a bug that would have
turned every real authoring turn into a 400. This is the second data
point (after 0013) that the reviewer's breadth compensates for gaps
in the test matrix. Seventh consecutive clean-pipeline run. — `123a836`

### 0013 Wire the agent authoring meta-agent _(7f84eed)_

The brain-swap of plan 0012. Shipped a new `packages/agent-authoring` package
(authoring flow, guardrails, patch validation with Zod re-application,
repair loop, audit sink, model client, feature flag, snapshot tests),
`/api/agents/builder/turn` route with owner-role gating and payload
ceilings, and swapped `/app/agents/new` to the LLM-backed authoring flow
behind `authoring.llm_enabled` (dev-on, prod-off). 28 files, 4044
insertions — largest plan shipped so far. Converged on review pass 3
after two fix cycles. Provider was Anthropic (Claude Sonnet default,
Opus on repair) at land; plan 0035 later swapped it to OpenAI
GPT-5.4-mini / GPT-5.4 without touching the interface.

**Review pass 1** found one Critical (client-supplied
`connectedProviders` would let a caller claim any provider is connected
and bypass the connector guardrail — moved to server-resolved
`getWorkspaceConnectedProviders(workspaceId)`), plus two Mediums
(missing audit sink wiring, runtime `readFileSync` of
`docs/prompts/builder-system.md` would break server bundles — inlined
as a const with a drift test).

**Review pass 2** found three Mediums (turn endpoint missing
`session.role === "owner"` check matching the rest of the agent
surface, no server-side bounds on `history`/`draft` payloads so a
client bug could rack up unbounded model cost, no route-level test
for the new endpoint) plus two Lows (guardrails trusting client
`history` for consent decisions — documented as model-safety not
integrity boundary; `parseTurn` placeholder draft leak).

**Takeaway**: **sixth consecutive clean-pipeline run**, and the
largest one by a wide margin. The reviewer caught exactly the class
of issue that matters when a new LLM endpoint is added: cost-attack
vectors, authorization drift from sibling routes, server-vs-client
trust boundaries. The two fix cycles both closed every blocker found.
For the target state — a planner agent that decomposes a spec and
shoots plans at the runner — this is the first data point that
says the current loop scales to plans in the thousands-of-lines
range. The "ship infra behind a deterministic stub, transplant LLM
in a follow-up" pattern noted at 0012 paid off: 0012 merged clean on
pass 2, 0013 did the brain-swap without UI surgery, each plan
stayed tractable. — `7f84eed`

### 0034 Harden first-run readiness _(00e4e34)_

Plan born from the 0012 post-landing UAT — first full sign-in-to-save
run through a live Google OAuth app, not mocks. Shipped in a single
clean-pipeline run (fifth consecutive). Changes: `predev` auto-applies
pending migrations before `next dev`, three connector callbacks
(gmail/calendar/hubspot) log structured JSON errors instead of
swallowing them, `/app/connections` always renders three connector
cards regardless of state, and a new
`scripts/first-run-readiness.sh` probes DB reachability, migration
drift, env-var completeness, and expected-table presence.

**Takeaway**: **the mocked e2e gate is not the same as first-run
readiness against a real environment**. Three classes of failure
slipped through a clean e2e gate because mocks cover behavior, not
configuration: (a) the dev database had no bootstrap so new
migrations never ran, (b) provider-side config (Gmail API disabled
on Google Cloud) surfaced only as a generic error code, (c) the
connections UI's "empty state" hid two of three connector cards
until the first connection existed. The new `first-run-readiness.sh`
probe + structured logs + always-three-cards UI close the gap for
this class. It's the first plan where the UAT-to-plan pipeline
(UAT finds issue → plan is drafted → plan ships in one clean run)
completed inside a single working session. —
`00e4e34`

### 0012 Build agent authoring conversational UI _(50211c3)_

Largest UI plan in the roadmap. Shipped the two-pane `/app/agents/new`
Authoring: chat component with quick-reply chips and inline-edit, live
spec preview pane, state-machine reducer with seven interview states,
deterministic scripted authoring flow (a test implementation of the
interface that 0013 will swap for
a Claude-backed version). Converged `No blocking findings.` on pass 2. Fourth consecutive clean-pipeline run.

**Takeaway**: the largest single UI plan remaining landed on the same
rails as the connector and central-artifact plans. The
"implementation → interview-skeleton as state machine → swap in LLM
later" pattern made 0012 tractable: a deterministic stub shipped now
means 0013 is a narrower scope (brain-swap only, no UI surgery).
Worth remembering as a general shape for plan pairs where the
expensive part is infrastructure and the interesting part is a model
call: ship the infra first behind a deterministic stub, then
transplant the LLM in a separate plan. — `50211c3`

### 0011 Ship agent template library _(cf8e295)_

First full product plan that touched both `packages/agent-definition` and
a net-new UI surface (`/app/agents/new` list + detail + create flow).
Three vertical templates shipped (Real Estate, Law Firm, Clinic) with
role-to-template mapping and missing-connection banners. Review took
3 passes to converge — two fix rounds on blockers, then
`No blocking findings.` on pass 3. Pipeline otherwise clean: local
e2e + merge-check e2e + CI e2e all green, merge-readiness saw through
the preamble bullet via the hardened parser, auto-merge fired
without intervention.

**Takeaway**: **third consecutive clean-pipeline run**, and the first
where the plan mixed data-layer work with a brand-new UI route. More
surface, one extra review pass — still zero human keystrokes between
fire-off and merge. Pattern is holding across plan classes. —
`cf8e295`

### 0010 Define agent definition schema and storage _(a6a4e8e)_

First central-artifact plan (the agent definition is the contract every
downstream Authoring / Runtime / Trust plan reads or writes). Shipped
`packages/agent-definition` with Zod validators, the `agents` /
`definition_versions` tables, workspace-scoped repository functions,
`/api/agents/*` CRUD endpoints with structured validation-error
surfacing. Converged `No blocking findings.` on pass 1; second
consecutive clean-pipeline run (no human keystrokes between
`./scripts/run_task.sh 0010` and main advancing).

**Takeaway**: when the harness is healthy, central-artifact plans
land as cleanly as connector plans. The structural work that made
0009's clean run possible (self-reference filter, invocation-local
gate, hardened parsers, e2e-verified merge) generalises across plan
classes. Two-in-a-row is the first signal that fork-and-go is
actually approachable from here. — `a6a4e8e`

### 0009 Connect HubSpot CRM via OAuth _(7137921)_

Third connector. First plan to land through the full pipeline
(e2e-verify in `all` mode + e2e-verify in merge-check + hardened
`merge_is_ready` parser) without any manual intervention at any
step. Review converged `No blocking findings.` on pass 2 (one fix
cycle). Both local e2e-verify runs green; CI `e2e` workflow green;
merge-readiness correctly emitted the sentinel and `merge_is_ready`
saw through a preamble bullet exactly like the one that blocked 0008.

**Takeaway**: the connector pattern is fully amortised. Three
connectors with the same shape, the third one running clean from
branch-create through squash-merge. The self-correcting loop plus
the hardened parsers plus the e2e-verified gate now compose into a
workflow that fit the "minimal human" framing for this specific
plan class: zero human keystrokes from `./scripts/run_task.sh 0009`
to `main` advancing. — `7137921`

### 0008 Connect Google Calendar via OAuth _(87b0244)_

First connector plan through the full e2e-verified pipeline. Converged
`No blocking findings.` on pass 1 — the Gmail connector pattern (0007)
fully amortised. Local e2e-verify ran twice (post-prepare-pr +
merge-check), both passed. CI `e2e` workflow passed. Merge-readiness
review correctly emitted `No findings. Ready to enable auto-merge.`
but led with a preamble bullet — `merge_is_ready` only checked the
first non-empty line, missed the sentinel, refused the merge.

**Takeaway**: `review_is_clean` got defensive matching in `28ee9b7`
for this exact class of drift; the sibling parser `merge_is_ready`
was not updated at the same time and bit us six plans later. See
the "Propagate parser fixes" primitive above. Merged manually;
`3a21a51` mirrored the defensive pattern onto `merge_is_ready`. —
`87b0244`, parser fix `3a21a51`

---

## Meta-lessons (patterns across plans)

### Friction produces durable fixes

Every friction point has become a permanent improvement to the harness
itself, not a one-off workaround:

- 0003's Low-finding churn → severity tiers
- 0006's auto-merge race → self-reference filter
- 0007's review exhaustion → bumped default budget
- 0030's UAT failure → `e2e-verify` phase

The harness improves itself through its own loop. This is the most
important property of the system.

### "Autonomy" is tiered, not binary

| Tier               | What the agent can do                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Build              | Write code, restructure modules, run static analysis — ~autonomous                             |
| Verify code        | Read diff, grep for patterns, check CI — ~autonomous                                           |
| Verify product     | Exercise UI, complete flows, assert user outcomes — **gap** (0032 closes most)                 |
| Verify third-party | Complete OAuth consent, pay with real money, receive real email — **requires humans or mocks** |
| Act in the world   | Move money, send real email, book real rooms — bounded by policy engine, always audited        |

Anyone claiming "autonomous software engineering" without being precise
about which tier is waving hands.

### Documentation lies until proven

Every prompt, every README step, every `.env.example` line is a
prediction about the future. It is true only when a mechanical check
verifies it. 0030 proved this in both directions — three different
operators could have read the LOCAL*DEV.md flow and each followed it
differently, because nothing \_ran* it.

`doctor.sh`, `e2e-verify`, CI — these are all ways of converting
documentation into truth.

### Plans are contracts; contracts can be amended

Silent drift is bad. Open amendment is fine. 0007's switch from
`google-auth-library` to raw fetch should have been a Locked Decision
amendment, not a comment at the top of the generated file. Encode the
amendment, date it, cite the trigger (which review pass flagged it),
move on.

### The review budget is the single biggest autonomy knob

Too low and connector plans manual-drive. Too high and CI burns. Tune
per-plan with `--max-review-passes <n>`, and let repeated overrides for
similar plan classes inform the default.

### Skills availability ≠ skills use

Vendoring `frontend-design` into `.claude/skills/` made the skill
_available_ to `claude -p` subprocesses. It did not make Claude
_use_ it. Skills trigger on description match; plans that want a skill
invoked should reference the task description in language that matches
the skill's trigger.

### The merge-readiness agent should not re-review

Its job is a different function. Material gates (draft flag, CI status,
diff severity, PR body structure) only. If you find it re-running the
code review, you've forgotten the role split.

---

## Reusable artifacts

What to copy when forking the harness to a new project:

- `AGENTS.md` — table of contents for the harness, intentionally short
- `scripts/run_task.sh` — the orchestrator, including phase dispatch,
  review-fix loop, preflight, PR prep, merge-readiness, auto-merge,
  review-ui, e2e-verify
- `scripts/preflight.sh`, `scripts/prepare_pr.sh`,
  `scripts/enable_automerge.sh`, `scripts/doctor.sh`,
  `scripts/validate_repo_docs.py` — mechanical checks
- `docs/prompts/` — the prompts for each phase, with severity tiers,
  preamble rules, and material gates
- `docs/workflows/agent-delivery-loop.md` — the human-readable narrative
- `docs/exec-plans/execution-plan-template.md` plus any well-written
  plan (e.g., 0002, 0007, 0029) as a reference
- `.github/workflows/agent-automerge.yml` — the label-triggered merge
  workflow with the right permission set (`checks: read` plus the usual)
- `.github/pull_request_template.md` — with the renamed "Self-review
  loop converged" checkbox
- `.claude/skills/` — vendored skills that should be available to every
  `claude -p` subprocess on the project
- `.gitignore` covering `.env*` with `!.env.example` exception

The plans themselves are project-specific; the scaffolding is portable.

---

## Known gaps

What we haven't solved, honestly:

- **OAuth consent for real third parties.** Plan 0033 will ship a mock
  OAuth server for test mode. Production still requires a human on the
  first grant per workspace.
- **Real payment verification.** Stripe test mode covers most cases; real
  money movement will stay human-gated.
- **Real email delivery verification.** A local SMTP capture unblocks
  test assertions; real deliverability is downstream.
- **Visual regression baselines.** Nothing in the loop tracks pixel-level
  UI drift. Separate plan.
- **Open-web automation.** Browser automation is planned (0031+N trio),
  but anti-bot / CAPTCHA handling at production scale remains partly
  solvable, partly a vendor dependency (Browserbase et al.).
- **Subjective design quality.** The reviewer can enforce the cookbook's
  "no Arial" anti-pattern. It cannot tell you that the hero feels cold.
  Human taste is a gate on major UI milestones.
- **Resume after a mid-phase rate limit has no persistent run state.**
  When `scripts/run_task.sh` hits an Anthropic 429 inside a
  long-running `claude -p` phase, the subprocess exits non-zero and the
  only surviving state is uncommitted working-tree changes plus the
  branch name. A fresh Claude Code session picking up the plan has to
  reconstruct from `git status` and the plan file which Execute step
  was in flight and what's already done. Seen concretely on 0023: the
  implement phase landed ~4.8k LOC of approval-queue code (the
  `@product/approvals` package, route, API handlers, worker entries),
  hit the rate limit after the first preflight attempt, and resumed in
  a new session that had to re-derive state. The resume session also
  defaulted to Claude Code's cautious "ask before acting" posture
  rather than `run_task.sh`'s phase-specific "auto-fix and re-run
  preflight" semantics — stalling on a routine `prettier --write` of
  four pre-existing unformatted plan docs (0048/0050/0052/0054)
  pending confirmation, rather than treating the fix as the mechanical
  auto-fix the loop is supposed to apply. Plan 0050 (orchestrator /
  watcher daemon) introduces the persistent run-state file the resume
  path needs; plan 0052 (budget governance + rate-limit detection)
  turns a 429 into a structured pause/resume instead of a raw process
  exit. Until those ship, mid-phase rate limits produce manual-drive
  recoveries and the resume agent has to be told "keep going, auto-fix
  trivial preflight failures" to match loop semantics.

---

## If you're forking this harness for a different project

Minimum viable harness:

1. Copy the scripts directory, the prompts directory, the PR template,
   and the GitHub Actions workflows.
2. Adapt `scripts/validate_repo_docs.py` — its `REQUIRED_FILES` list is
   project-specific; most other checks are portable.
3. Write a first execution plan in the established shape (Goal, Why Now,
   Visual or Technical Thesis, Locked Decisions, Content Plan or Data
   Model, Scope, Acceptance Criteria, Out Of Scope, Milestones,
   Read-First Files, Trigger Shortcuts, Execution Steps, Validation,
   Open Questions, Decision Log).
4. Run it. Observe what breaks. Fix the harness; don't paper over.
5. Append the lesson to your fork's copy of this document.

The harness's value compounds with use. Each plan that merges is also
a test of the scaffolding; each friction point that produces a fix
makes the next plan easier. Expect the first three plans to run rough
and the fourth onward to feel effortless on happy paths.
