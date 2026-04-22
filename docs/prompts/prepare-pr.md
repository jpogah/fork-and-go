# Prepare PR Prompt

Read the execution plan and the generated PR template before writing.

## Instructions

1. Use the generated PR body as the starting point.
2. Replace every `TODO` with concrete content based on the actual diff.
3. Keep the summary tight and user-facing where possible.
4. Make risks specific instead of generic.
5. Keep follow-ups limited to real deferred work.
6. Under **Review Loop**, tick `- [x] Self-review loop converged with no blocking findings` — by the time this phase runs, the self-review loop has already converged; leaving the box unchecked misrepresents the state and triggers spurious merge-readiness findings.
7. Leave `- [ ] agent/automerge will only be added when the PR is ready` unchecked. The merge-check phase adds the label.

## Output Rules

- Output **only** the final PR body as Markdown.
- The first line of output must be `## Summary`. Do not include any preamble, planning notes, meta-commentary, or explanatory paragraphs before or after the Markdown.
- Do not wrap the response in code fences.
