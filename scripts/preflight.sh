#!/usr/bin/env bash
# preflight — the single sanity gate before opening a PR.
#
# CUSTOMIZE ME. The plan-graph validation is generic and should stay.
# Replace the stack-specific section below with your project's check / lint /
# typecheck / test / build pipeline.
#
# This script is called from `run_task.sh --phase prepare-pr` and `--phase all`.
# A non-zero exit blocks the PR from opening.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Validating plan frontmatter and dependency graph"
./scripts/plan-graph.sh validate

echo "==> Running project-specific checks"
# -----------------------------------------------------------------------------
# REPLACE THIS BLOCK with your stack's pipeline.
#
# Node monorepo:
#   npm run check        # e.g. docs-validate && format:check && lint && typecheck && test && build
#
# Rust:
#   cargo fmt -- --check
#   cargo clippy -- -D warnings
#   cargo test
#   cargo build
#
# Python:
#   ruff check .
#   mypy .
#   pytest
#
# Makefile-driven:
#   make lint test build
# -----------------------------------------------------------------------------
echo "    (no project-specific checks configured — edit scripts/preflight.sh)"
echo "    see CUSTOMIZE.md for examples."

echo "==> Preflight passed."
