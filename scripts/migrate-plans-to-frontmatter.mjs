#!/usr/bin/env node
// One-shot migration that prepends YAML frontmatter to every plan file under
// docs/exec-plans/{active,completed}/. Idempotent — if a file already has a
// valid `---` block on the first line, we leave it untouched. Seeds depends_on
// conservatively:
//   - plans listed in DEPENDENCY_OVERRIDES use the explicit edge list;
//   - every other plan depends on its numeric predecessor within the same phase.
// Defaults: status comes from the directory, estimated_passes = 3,
// acceptance_tags = []. Operators refine over time by editing plan files.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ACTIVE_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "active");
const COMPLETED_DIR = path.join(REPO_ROOT, "docs", "exec-plans", "completed");

// Phase per plan id. Canonical source is docs/PLANS.md today; we encode the
// mapping here so the migration is self-contained. After migration, phase
// lives in the frontmatter and PLANS.md is regenerated from that.
const PHASE_BY_ID = {
  "0001": "Foundation",
  "0002": "Marketing",
  "0003": "Marketing",
  "0004": "Foundation",
  "0005": "Foundation",
  "0006": "Foundation",
  "0007": "Connectors",
  "0008": "Connectors",
  "0009": "Connectors",
  "0010": "Agent Authoring",
  "0011": "Agent Authoring",
  "0012": "Builder",
  "0013": "Builder",
  "0014": "Builder",
  "0015": "Runtime",
  "0016": "Runtime",
  "0017": "Runtime",
  "0018": "Executors",
  "0019": "Executors",
  "0020": "Executors",
  "0021": "Trust",
  "0022": "Trust",
  "0023": "Trust",
  "0024": "Billing",
  "0025": "Billing",
  "0026": "Billing",
  "0027": "Ops",
  "0028": "Ops",
  "0029": "Brand polish",
  "0030": "Demo enablement",
  "0031": "Demo enablement",
  "0032": "Verification",
  "0033": "Verification",
  "0034": "Verification",
  "0035": "Builder",
  "0036": "Verification",
  "0037": "Trust",
  "0038": "CMO",
  "0039": "CMO",
  "0040": "CMO",
  "0041": "CMO",
  "0042": "CMO",
  "0043": "CMO",
  "0044": "CMO",
  "0045": "CMO",
  "0046": "CMO",
  "0047": "CMO",
  "0048": "Harness",
  "0049": "Harness",
  "0050": "Harness",
  "0051": "Harness",
  "0052": "Harness",
  "0053": "Harness",
  "0054": "Harness",
};

// Explicit cross-plan dependencies drawn from each plan's text ("reuses N",
// "requires N merged", "builds on N"). For plans not listed here the migration
// falls back to the numeric predecessor in the same phase. Operators refine
// by editing plan files; re-running this script never touches files that
// already have frontmatter.
const DEPENDENCY_OVERRIDES = {
  "0014": ["0013"],
  "0017": ["0015", "0016"],
  "0018": ["0007", "0017"],
  "0019": ["0008", "0017", "0018"],
  "0020": ["0009", "0017"],
  "0021": ["0016", "0017", "0018", "0019", "0020"],
  "0022": ["0016", "0017"],
  "0023": ["0016", "0017", "0022"],
  "0026": ["0024", "0025"],
  "0030": ["0002", "0003", "0004", "0005", "0007"],
  "0031": ["0030"],
  "0032": ["0030", "0031"],
  "0033": ["0032"],
  "0034": ["0007", "0008", "0009", "0012", "0032"],
  "0036": ["0007", "0008", "0009", "0034"],
  "0037": ["0010", "0015", "0022"],
  "0038": ["0007", "0008", "0009"],
  "0039": ["0017", "0018", "0038"],
  "0040": ["0013", "0018", "0035"],
  "0041": ["0038", "0039", "0040"],
  "0042": ["0007", "0008"],
  "0043": ["0017", "0018", "0042"],
  "0044": ["0018", "0040", "0042", "0043"],
  "0045": ["0040"],
  "0046": ["0040"],
  "0047": ["0040"],
  "0048": [],
  "0049": ["0048"],
  "0050": ["0048", "0049"],
  "0051": ["0049"],
  "0052": ["0050"],
  "0053": ["0048", "0049", "0050"],
  "0054": ["0048", "0049", "0050"],
};

const DEFAULT_ESTIMATED_PASSES = 3;

function listPlanFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^\d{4}-[a-z0-9-]+\.md$/u.test(entry.name),
      )
      .map((entry) => path.join(dir, entry.name));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

function idFromFilename(filename) {
  const match = /^(\d{4})-/u.exec(filename);
  return match ? match[1] : null;
}

function extractTitle(body) {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^#\s+\d{4}\s+(.+)$/u.exec(trimmed);
    if (match) return match[1].trim();
    const plainMatch = /^#\s+(.+)$/u.exec(trimmed);
    if (plainMatch) return plainMatch[1].trim();
    break;
  }
  return null;
}

function hasFrontmatter(text) {
  const lines = text.split("\n");
  return lines[0] === "---";
}

function computeDependsOn(id, allIds, location) {
  if (location === "completed") return [];
  if (Object.prototype.hasOwnProperty.call(DEPENDENCY_OVERRIDES, id)) {
    return DEPENDENCY_OVERRIDES[id];
  }
  const phase = PHASE_BY_ID[id];
  if (!phase) return [];
  const predecessors = allIds
    .filter((otherId) => otherId < id && PHASE_BY_ID[otherId] === phase)
    .sort();
  const predecessor = predecessors[predecessors.length - 1];
  return predecessor ? [predecessor] : [];
}

function buildFrontmatterBlock(data) {
  const ordered = {
    id: data.id,
    title: data.title,
    phase: data.phase,
    status: data.status,
    depends_on: data.depends_on,
    estimated_passes: data.estimated_passes,
    acceptance_tags: data.acceptance_tags,
  };
  const yamlBody = YAML.stringify(ordered, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
  return `---\n${yamlBody}---\n`;
}

function migrate() {
  const activeFiles = listPlanFiles(ACTIVE_DIR).map((filePath) => ({
    filePath,
    location: "active",
  }));
  const completedFiles = listPlanFiles(COMPLETED_DIR).map((filePath) => ({
    filePath,
    location: "completed",
  }));
  const all = [...activeFiles, ...completedFiles];
  const allIds = all
    .map(({ filePath }) => idFromFilename(path.basename(filePath)))
    .filter((id) => id !== null);

  let written = 0;
  let skipped = 0;
  let unknownPhase = [];
  for (const { filePath, location } of all) {
    const filename = path.basename(filePath);
    const id = idFromFilename(filename);
    if (!id) continue;
    const original = readFileSync(filePath, "utf8");
    if (hasFrontmatter(original)) {
      skipped += 1;
      continue;
    }
    const title = extractTitle(original);
    if (!title) {
      throw new Error(`Could not extract title from ${filePath}`);
    }
    const phase = PHASE_BY_ID[id];
    if (!phase) {
      unknownPhase.push(id);
      continue;
    }
    const status = location === "completed" ? "completed" : "active";
    const depends_on = computeDependsOn(id, allIds, location);
    const frontmatter = buildFrontmatterBlock({
      id,
      title,
      phase,
      status,
      depends_on,
      estimated_passes: DEFAULT_ESTIMATED_PASSES,
      acceptance_tags: [],
    });
    const next = `${frontmatter}\n${original.startsWith("\n") ? original.slice(1) : original}`;
    writeFileSync(filePath, next, "utf8");
    written += 1;
  }

  if (unknownPhase.length > 0) {
    process.stderr.write(
      `migrate-plans-to-frontmatter: unknown phase for ids: ${unknownPhase.join(", ")}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `migrate-plans-to-frontmatter: wrote ${written}, skipped ${skipped} (already had frontmatter).\n`,
  );
}

migrate();
