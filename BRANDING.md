# Branding

Positioning, voice, and visual notes for Fork-and-Go. Iterate on this doc; it's the brief every piece of copy, site, talk, or ad references.

---

## Name

**Fork-and-Go.** Chosen because:

- It's the phrase already used in the harness's north-star section: *"fork-and-go autonomy."* The name matches the product.
- It's descriptive of what the thing does: fork the repo, write a plan, go.
- It's memorable and pronounceable. Hyphenation holds up in URLs, README headers, and talk slides.
- It's trademark-defensible — "Fork" alone is generic; "Fork-and-Go" as a compound is distinctive enough for registration.

Names explicitly rejected:
- **Claude-anything** — trademark infringement on Anthropic's marks. Also fragile if the agent landscape shifts.
- **Anthropic-anything** — same.
- **Convergent** — evocative but too generic English word; hard to own.
- **Planforge, Agentforge** — fine but less memorable than Fork-and-Go.

---

## One-line positioning

> **Agent-first delivery pipelines that ship while you're asleep.**

Variants by audience:

- **To engineers**: *"The harness around your coding agent: plan → implement → review → PR → merge, unattended."*
- **To CTOs**: *"Opinionated, repo-local orchestration for AI coding agents. The part you'd build yourself on the 4th plan."*
- **To investors**: *"Infrastructure for agent-first software delivery. 30+ production PRs merged through the same loop."*

---

## Taglines (short list)

- Agent-first delivery pipelines that ship while you're asleep.
- Plan it. Fork it. Go.
- The harness around the agent.
- From execution plan to merged PR, unattended.
- Ships 10-hour unattended runs. Fails safely. Learns in the loop.

Pick one for hero; rotate the others in talks / posts / ads.

---

## Positioning vs. alternatives

| Position | What they hear | What we say |
|---|---|---|
| "Isn't this Claude Code?" | Yes, Claude Code is an agent. We're the harness around it. *Claude Code writes the code. Fork-and-Go ships the PR.* |
| "Isn't this Devin?" | Devin is a closed service. We're a forkable open-source harness you run on your own repo, with your own agent, with full audit. |
| "Isn't this Cursor?" | Cursor is an IDE for interactive editing. We're the unattended pipeline. Different job. |
| "Isn't this Aider?" | Aider is a chat interface. We're the orchestration that wraps any agent through a phased delivery loop with severity-tiered review + merge gates. |

**Do not position against Claude Code as a competitor.** Position as complementary: Claude Code is the engine; Fork-and-Go is the vehicle. Anthropic DevRel should feel good promoting us.

---

## Voice and tone

- **Specific over impressive.** "Ships 10-hour unattended runs" beats "revolutionary AI delivery." Every claim should be falsifiable.
- **Field-report register.** Like a senior engineer explaining what happened, not a marketer selling a tool. Read Gergely Orosz, Simon Willison, Dan Abramov for reference.
- **Admit friction.** The harness has known gaps — the field notes name them. Honesty is the moat.
- **No hype, no emojis in prose.** Occasional emoji in release notes or README flair is fine. Avoid 🚀 / ✨ / 🎉 in headlines.
- **Short sentences. Active voice. Verbs that carry weight.**

---

## Claims we can make (all verifiable)

- "30+ merged PRs through the same loop." Point at the case-study commits.
- "1,200+ lines of field notes from real production plans." Point at `HARNESS_ENGINEERING.md`.
- "Self-review loop converges in 2-5 passes on typical plans." Cite the merged-PR data.
- "Works with Claude Code today. Designed for any agent."
- "MIT licensed. Fork it, run it, ship with it."

## Claims to avoid

- "Replaces human code review." (It doesn't — it's *self*-review + merge gates; humans still own design decisions and real review on large PRs.)
- "Zero-human autonomous." (It's *minimal*-human; humans are still context providers, tool unblockers, and clarifiers. See `docs/HARNESS_ENGINEERING.md`.)
- "Works with any AI model." (It works with what we've tested. Claude Code today. Codex adapter experimental.)
- Any productivity multiplier ("10x faster!") — unverifiable, marks you as a hype shop.

---

## Visual identity (to define)

Placeholder — iterate before launch.

- **Logo**: not designed yet. Concept direction: a split path or a fork glyph paired with a forward arrow. Monochrome-capable. Works at 16x16 (favicon) and 512x512 (social card).
- **Color**: ship with a disciplined, nearly-monochrome palette. One accent. Avoid the AI-tool purple-and-cyan gradient cliché.
- **Typography**: pick one well-made sans (Inter, IBM Plex Sans, Geist) for body and one disciplined serif or mono for display. Consistent across site, docs, slides.
- **Social card**: 1200x630, plain background, strong tagline, no screenshots. A tagline that works in a browser tab is the card.

The visual brand should feel like a tool an experienced operator would choose — closer to Vercel / Linear / Tailwind than to most AI-startup aesthetics.

---

## Domain and handles to reserve

Before public launch, acquire:

- Domain: `fork-and-go.dev` (primary). Secondary: `forkandgo.dev`, `fork-and-go.com`.
- GitHub org: `fork-and-go` (preferred) or `forkandgo`.
- npm scope: `@fork-and-go` for the plan-graph package.
- Social: `@forkandgo` on X, Bluesky, GitHub, Hacker News handle.

Trademark: file USPTO registration for "Fork-and-Go" in class 9 (software) and 42 (SaaS / developer tools) before the first public announcement. ~$300 per class via filing service.

---

## Content plan (first 3 months)

- **Month 0 (launch week)**: README, HARNESS_ENGINEERING.md, landing page, Hacker News Show HN, one long-form field report ("Running an agent through 30 merged plans").
- **Month 1**: one post per week — each one a specific lesson from the field notes distilled for a general audience. Topics: severity-tiered review, convergence sentinels, the role-split reviewer/fixer trick, why PR bodies should be generated, the resume-after-rate-limit failure mode.
- **Month 2**: v0.2 release post (persistent run-state + rate-limit detection), Anthropic DevRel outreach, first community plan-of-the-month showcase.
- **Month 3**: v0.3 release post (planner agent), talk proposal to one engineer-focused conference, case-study interview with a fork that shipped something real.

Goal at 90 days: 2-3 active external forks, 500+ README stars, 1-2 conference talks accepted, Anthropic DevRel aware of us.
