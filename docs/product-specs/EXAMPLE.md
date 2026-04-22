# Example Product Spec — RSS Digest Agent

This is the reference spec used to validate the planner agent (0049). It is
intentionally concrete enough that the planner can emit a sensible three-
to-five-plan decomposition, and intentionally small enough to keep the
validation run cheap.

## Problem

Our marketing and product teams want to stay aware of what competitors and
industry voices are publishing without manually scanning twenty RSS feeds
every morning. Today they paste links into a shared Slack channel once or
twice a week, skipping over noisy feeds and missing items whose titles
don't look interesting but whose bodies are.

## Goals

- Give an operator a way to subscribe an agent to a list of RSS feeds.
- The agent fetches new items on a daily cadence.
- It summarizes each item in two or three sentences grounded in the body
  (not just the title) and flags items that match operator-defined topics
  of interest.
- Flagged items land in an approval queue; the operator can approve,
  archive, or forward to a Slack channel or email digest.
- After ten consecutive clean approvals for "forward to email," the agent
  graduates that action to auto.

## Non-goals

- Publishing back to an RSS feed. This agent only consumes.
- Full-text search across a historical corpus. We only summarize items
  discovered after the agent activates.
- Social media listening (Twitter, LinkedIn, Reddit). Those belong in a
  separate agent and are out of scope for this spec.

## Surfaces

- A new "RSS Digest" entry in the agent template library at
  `/app/agents/new`, selectable alongside the existing templates.
- A connector card on `/app/connections` for "RSS" — doesn't require
  OAuth, but lets the operator paste or import an OPML file of feed URLs
  and stores them as connection knowledge.
- An executor kind (or kinds) that fetches RSS items, summarizes them,
  and files them under an approval.
- A daily-run agent spec template that stitches the above together.

## Acceptance

- An operator can pick the "RSS Digest" template, paste five to ten feed
  URLs, set "topics of interest" (free text), pick a delivery channel
  (email or Slack), and activate the agent.
- On the next daily run, the agent fetches new items, summarizes each
  matching topic, and files an approval per item.
- The operator sees the approvals queue populate, can approve / archive /
  forward, and sees graduation-to-auto happen after ten clean approvals.
- The e2e harness covers the template activation + first-run path; no
  network call is required at test time (the executor has a dry-run /
  fixture mode).
