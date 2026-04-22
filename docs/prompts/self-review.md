# Self-Review Prompt

Review this branch against `main`.

## Priorities

- bugs
- behavior regressions
- missing tests
- architecture violations
- docs drift

## Severity

Use four levels:

- **Critical**: security issue, data loss, corrupted state, or a functional bug that breaks an acceptance criterion in the plan.
- **High**: real bug or invariant violation that will cause production pain.
- **Medium**: missing test coverage, design drift, or a contract issue that should be fixed soon.
- **Low**: polish, nits, speculative edges, dev-only nuisances, or style preferences that are acceptable to land as tracked follow-ups.

Critical, High, and Medium are blocking. Low is not blocking — list these items so they can be picked up later, but do not re-raise the same Low finding across passes once it has been acknowledged.

## Output Rules

- The **first line of your response** must be exactly one of:
  - `No findings.` — nothing to report at any severity.
  - `No blocking findings.` — only Low-severity findings remain; list them after the sentinel as follow-ups, not blockers.
  - The first finding's severity heading (e.g. `### Critical` or `Critical — <title>`), when blocking findings exist.
- Do not put any preamble, explanation, meta-commentary, verification checklist, or planning paragraph **before** the sentinel or first finding. If you want to document verified invariants, put them after the findings / Low follow-ups.
- List findings ordered by severity, with file references for every item.
- Keep summaries brief.
