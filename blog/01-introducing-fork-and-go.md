---
title: "Introducing Fork-and-Go: agent-first delivery pipelines that ship while you're asleep"
subtitle: "A harness I built over the past year, open-sourced today, along with the 90,000-word field report about it."
date: 2026-04-23
author: Johnpaul Ogah
tags: [ai, agents, software-engineering, open-source, harness-engineering]
---

The first time I used an AI coding agent on a real codebase, I was mostly impressed. The second time, I was mostly annoyed. The third time, I was trying to figure out the shape of the annoyance.

The shape, I eventually realized, was this: the agent was very good at writing the code and approximately useless at everything that surrounds the code-writing. It could produce a function, a test, a migration, a component. It could not produce a merged pull request. The distance between "the function is written" and "the pull request is merged" turned out to be most of the actual engineering.

I spent the better part of a year building the scaffolding that closes that distance. Today I'm open-sourcing it as **Fork-and-Go**.

## What it is

Fork-and-Go is an opinionated harness for running coding agents — Claude Code today; others soon — through a full plan → implement → review → fix → PR → merge loop. You write a structured plan file in the morning. You type one command. The harness handles everything else: branching, writing the code, self-reviewing the diff with severity tiers, fixing blocking findings, generating a structured PR body, booting the dev server to verify the running product, gating the merge against material conditions, and squash-merging to main when it's safe.

The thing it's replacing isn't the coding agent. The thing it's replacing is *the hour of manual driving between "agent wrote the code" and "PR merged."* That hour is where the engineering lives. The harness does it so you don't have to.

The pipeline has six phases, each a separately-invoked agent with its own prompt, scoped tools, and structured output contract:

```
                   ┌─────────────────┐
                   │      Plan       │   docs/exec-plans/active/NNNN.md
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │   Implement     │   tools: read / write / execute
                   └────────┬────────┘   output: working-tree diff
                            │
                ┌───────────▼───────────┐
                │                       │
                │    ┌─────────────┐    │
                │    │   Review    │    │   tools: read-only
                │    └──────┬──────┘    │   output: severity-tiered
                │           │           │           findings
                │     `No blocking      │
                │       findings.`?     │
                │     ┌──┴──┐           │
                │  no │     │ yes       │
                │     ▼     └──────────►│
                │    ┌─────────────┐    │
                │    │     Fix     │    │   tools: read / write
                │    └──────┬──────┘    │   budget: up to 5 passes
                │           │           │
                │           └───────────┘
                │     review/fix sub-loop
                └───────────┬───────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │   Prepare PR    │   tools: git, gh
                   │                 │   output: four-section PR body
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │   E2E Verify    │   tools: Playwright MCP, dev server
                   └────────┬────────┘   sentinel: `E2E verification passed.`
                            │
                            ▼
                   ┌─────────────────┐
                   │   Merge Check   │   output: `No findings. Ready to
                   └────────┬────────┘            enable auto-merge.`
                            │
                            ▼
                   ┌─────────────────┐
                   │  GitHub Actions │
                   │    auto-merge   │
                   └─────────────────┘
```

The full architecture — what each phase's role is, why they have to be separately invoked, how the convergence sentinel works, why a four-section PR body matters — is in the companion book (more on that below). The short version: each primitive in that diagram earned its place from a specific failure on a specific plan, and the accumulation is what closes the demo-to-production gap.

## Why I built it

Over the past year, I ran approximately sixty execution plans through this harness against a production codebase. About fifty of those plans merged via the harness's own loop. Each plan that broke the harness in a specific way produced a specific primitive in response — the severity-tiered review came from a plan that converged on polish while real bugs shipped; the role split came from a plan where a consolidated agent signed off on its own fix; the rescue primitive came from an OAuth plan whose review budget exhausted with real findings still pending; the end-to-end verification phase came from a plan whose documented setup didn't boot on a fresh clone; the orchestrator daemon came from a multi-hour unattended run that exited on a rate-limit error with no persistent state to resume from.

None of these primitives was speculated into existence. Each has a commit hash. Each can be removed if future models obviate the gap it encodes. This is the central discipline of harness engineering, as far as I can tell: **friction produces durable fixes**. You run work through the harness, you watch for friction, and you add the minimum primitive that would have prevented the specific failure you just watched happen. The harness gets better by getting used.

There is a closing-loop observation worth sharing up front. On April 22, 2026 — yesterday — I shipped six plans in a single day, through the harness's own loop, that together complete the Tier-1 capability set the book's roadmap describes: plan schema and dependency graph (plan 0048), planner agent (0049), orchestrator / watcher daemon (0050), context ingestion (0051), budget governance and rate-limit detection (0052), spec-fidelity checker (0053), and top-level acceptance and release gate (0054). The harness completed its own Tier-1 arc through its own loop, in a day, with exactly the failure modes the book describes — a rescue fire, a rate-limit recovery, and one genuinely novel bash self-modification bug that will feed a new preflight stage in the weeks ahead. The self-referential closure is the most honest evidence I can offer that the thing actually works.

## What's in the repository today

`github.com/jpogah/fork-and-go` ships with:

- **The planner agent** (`packages/planner/`, `scripts/plan.sh`): reads a product spec and emits an ordered sequence of executable plans.
- **The runner** (`scripts/run_task.sh`): phase sequencing, tool-scope enforcement, rate-limit detection, resume-safe invocation.
- **The phase prompts** (`docs/prompts/*.md`): five prompts — feature-implementation, self-review, fix-review-findings, prepare-pr, merge-readiness — each carefully iterated against real plans. Copy them as-is for your first several plans; tune after you've seen real convergence behavior on your own workload.
- **The plan-graph library** (`packages/plan-graph/`): YAML frontmatter schema, resolver, dependency-graph validator, and `PLANS.md` drift-check. Plans are machine-readable first-class artifacts.
- **The orchestrator daemon** (`apps/orchestrator/`, `scripts/orchestrator.sh`): persistent state, pause/resume/stop/freeze controls, rate-limit backoff, and merge polling.
- **The context-ingest package** (`packages/context-ingest/`, `scripts/context.sh`): repo-local context drops with scope grammar and prompt-injection-aware rendering.
- **The budget governance package** (`packages/run-budget/`): token tracking, cost estimates, budget raise requests, and rate-limit detection.
- **The release gate** (`packages/release-gate/`, `scripts/release-gate.sh`): top-level acceptance criteria for deciding when the product is done.
- **The spec-fidelity checker** (`packages/fidelity-check/`, `scripts/check-fidelity.sh`): audits delivered work against the product spec and can suspend active plans on drift.
- **The generic model client** (`packages/model-client/`): a harness-level model client with Codex CLI and OpenAI backends.
- **The rescue primitive** (`scripts/run_task_loop.sh`): recovers plans whose review budget exhausts.
- **The plan template and PR template**: the structural contracts every plan and PR follow.
- **The GitHub Actions auto-merge workflow**: label-triggered squash-merge gated on CI.
- **Twelve hundred lines of field notes** (`docs/HARNESS_ENGINEERING.md`): every primitive's origin story, traceable to specific plan incidents and commit hashes.
- **MIT License, trademark-held name.** Fork it, ship with it, commercialize downstream work — just don't name your fork "Fork-and-Go."

The repository is deliberately un-productized. No SaaS wrapper. No hosted service. No config UI. The harness lives in your repo, is edited like any other part of the codebase, and evolves with your project's learning. This is not a compliance decision; it's a design one. Harnesses that live outside the team's repo cannot be audited, forked, or tuned by the team that uses them, which is the failure mode every closed agent-orchestration tool I've encountered shares.

## How it compares

There are three public documents that define the field of harness engineering as of 2026: Wiesinger, Marlow, and Vuskovic's *Agents* whitepaper from Google (September 2024), which gives the field its vocabulary; Anthropic's *Harness Design for Long-Running Application Development* post (2025), which describes the generator-evaluator-feedback pattern and the context-reset-over-compaction discipline; and OpenAI's *Harness Engineering: Leveraging Codex in an Agent-First World* post (March 2026), which describes an internal experiment that shipped one million lines of code across fifteen hundred PRs, entirely through agents, with no manually-written code, in five months.

Fork-and-Go sits in the middle of that landscape. It takes Wiesinger et al.'s vocabulary as given (agent = model + orchestration + tools), extends Anthropic's generator-evaluator split to cover the merged-PR delivery problem (adding a fix loop, a PR-body generator role, a merge-check gate, an e2e-verify phase), and scales downward from OpenAI's binary-review architecture to a small-team fix-loop architecture where token cost still matters. If OpenAI's harness is the extreme, Fork-and-Go is the middle-scale version: for teams of one to three engineers who want agent-first engineering without OpenAI's infrastructure budget and without Anthropic's greenfield-app focus.

Concretely versus the tools people already know:

- **Versus Claude Code (or Codex CLI)**: Claude Code is the agent. Fork-and-Go is the harness around the agent. Claude Code writes the code. Fork-and-Go turns the code into a merged PR. They are complementary, not competitive. Fork-and-Go runs on Claude Code today.

- **Versus Cursor / Windsurf**: those are IDEs for interactive editing. Fork-and-Go is the unattended pipeline. Different job. If you like Cursor for writing code, you can still use Fork-and-Go for shipping it.

- **Versus Devin / Cognition**: Devin is a closed service. Fork-and-Go is an open-source harness you run against your own repo, with your own agent, with full audit. Different model.

- **Versus "just running Claude Code in a loop"**: the primitives in Fork-and-Go — the severity-tier review, the role split, the generated PR body, the merge-check gate, the preflight discipline — are what separates "runs in a loop" from "ships merged PRs." If your loop doesn't have these, it's doing the first five percent of the work and handing the rest back to you.

## Quickstart

```bash
# 1. Clone, install deps
git clone https://github.com/jpogah/fork-and-go.git my-project
cd my-project
npm install

# 2. Preview generated plans from the example spec
./scripts/plan.sh docs/product-specs/EXAMPLE.md --preview

# 3. Or write a plan by hand
cp docs/exec-plans/execution-plan-template.md \
   docs/exec-plans/active/0001-my-first-feature.md
$EDITOR docs/exec-plans/active/0001-my-first-feature.md

# 4. Run it
./scripts/run_task.sh 0001 --skip-e2e
```

First plans almost always expose one or two configuration issues specific to your codebase (preflight speed, doctor-script shape, e2e-verify dev-server pattern). Budget half a day for the first plan's integration-test role. The curve flattens after the first eight to twelve merged plans.

The [CUSTOMIZE.md](../CUSTOMIZE.md) in the repo walks through what to tune, what to leave alone, and what's already generic. [ROADMAP.md](../ROADMAP.md) lays out where the next releases go.

## The book

If you want the full story — the primitive-by-primitive defenses, the field narratives of what broke and what fixed it, the five-tier taxonomy of what's actually autonomous versus what isn't, the specific discipline of writing a plan the loop can execute — I wrote a book about it.

*Agent-First Engineering: A Field Report on Shipping Software With AI Coding Agents.* ~90,000 words. Seventeen chapters across five parts (the setup, the primitives, the field narratives, the meta-lessons, the playbook). Three appendices (the prompts verbatim with annotations, the plan template with a worked example, the glossary). Bibliography of exactly three sources — the three public documents above — engaged carefully rather than decoratively.

The book is published on Amazon: <https://www.amazon.com/dp/B0GYBLMY5L>.

## What's next

Fork-and-Go now includes the full Tier-1 harness arc in the repo: planner, daemon, context ingestion, budget governance, spec-fidelity checker, release gate, and the generic model client that removes the old product-specific coupling. The public roadmap (`ROADMAP.md` in the repo) lays out the next several releases:

- **v0.3** — adapter infrastructure. The harness is agent-agnostic by design; a clean adapter interface for Codex, Cursor agent mode, Aider, and others is the next hardening target.
- **v0.4** — spec-to-spec communication between forked harnesses, so teams can share learnings and primitives without either maintainer reading every plan in the other's repo.
- **v0.5+** — calibration against more external forks and longer unattended runs.

The sixth-gap research question — spec-to-spec communication between forked harnesses, so that two teams running Fork-and-Go can share learnings and primitives without either maintainer reading every plan in the other's repo — is open research. I don't have an architecture for it. Whoever ships it first contributes a primitive at least as important as anything in the Tier-1 arc I shipped yesterday.

## Call to action

If you're already trying to ship software through AI coding agents and hitting the same walls I've described here — the review that won't converge, the PR body that's a list of changed files, the six-hour run that exits on a rate limit with no state to resume from — **clone Fork-and-Go, run the example plan, and report what breaks.** Fork it. Try it against your codebase. Send field reports back via GitHub Issues or to **johnpaul.ogah@solidrocksoftwarecloud.com**.

The harness gets better by getting used. Every friction you surface, in your fork, informs the next primitive. This is how the field advances.

**Links:**
- Repo: `github.com/jpogah/fork-and-go`
- The field journal: `docs/HARNESS_ENGINEERING.md` in the repo
- The book: <https://www.amazon.com/dp/B0GYBLMY5L>
- My writing on agent-first engineering: [blog URL]
- Direct feedback: **johnpaul.ogah@solidrocksoftwarecloud.com**

The loop that built the primitives built the book that explains the primitives, and finished its own Tier-1 capability set through its own loop on the same day the manuscript was revised for publication. The harness is the engineering. The engineering is where the leverage is. Build the harness.
