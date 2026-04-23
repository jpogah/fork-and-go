#!/usr/bin/env bash
# bootstrap-e2e.sh — scaffold the minimum Playwright + heavy-smoke test
# setup that the harness's `e2e-verify` phase depends on.
#
# Run this once per fork, after you've scaffolded your Next.js (or
# equivalent) app at apps/web/. It installs @playwright/test, downloads
# the chromium browser, writes a baseline playwright.config.ts + a
# heavy-smoke test suite, and wires `e2e` + `e2e:install` scripts into
# both apps/web/package.json and the root workspace package.json.
#
# Idempotent: re-running against an already-bootstrapped repo is a
# no-op (checks for existing config + script before writing).
#
# Why this script exists: plan-level implementers can't scaffold this
# cleanly as part of a plan. Playwright's web-server lifecycle, the
# port-contention story with the operator's local dev, and the
# `.next-e2e` cache dir are all cross-cutting harness/scaffold
# concerns. The book calls these out in Chapter 15 (Forking the
# harness) as project-shaped components every fork must provide.
#
# Usage:
#   ./scripts/bootstrap-e2e.sh
#
# Requires:
#   - npm workspaces configured at the repo root
#   - apps/web/ exists with a valid package.json
#   - internet access for npm install + playwright install

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB_DIR="apps/web"
TESTS_DIR="$WEB_DIR/tests/e2e"
PW_CONFIG="$WEB_DIR/playwright.config.ts"
SMOKE_SPEC="$TESTS_DIR/smoke.spec.ts"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

note() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# Precondition checks
# ---------------------------------------------------------------------------
[[ -d "$WEB_DIR" ]] || die "$WEB_DIR/ does not exist. Scaffold your Next.js app there first."
[[ -f "$WEB_DIR/package.json" ]] || die "$WEB_DIR/package.json missing."
[[ -f "package.json" ]] || die "Root package.json missing — this script assumes npm workspaces."

# ---------------------------------------------------------------------------
# 1. Install @playwright/test + chromium
# ---------------------------------------------------------------------------
if node -p "Object.keys(require('./$WEB_DIR/package.json').devDependencies||{}).includes('@playwright/test')" \
     2>/dev/null | grep -qx true; then
  note "@playwright/test already in $WEB_DIR/package.json — skipping install."
else
  note "Installing @playwright/test in $WEB_DIR..."
  npm install --workspace "$(node -p "require('./$WEB_DIR/package.json').name")" \
    --save-dev @playwright/test >/dev/null
fi

note "Ensuring chromium browser is installed..."
npx --yes playwright install --with-deps chromium >/dev/null 2>&1 || \
  note "  (playwright install ran; minor warnings from Node ESM-require are harmless)"

# ---------------------------------------------------------------------------
# 2. Write playwright.config.ts (if not already present)
# ---------------------------------------------------------------------------
if [[ -f "$PW_CONFIG" ]]; then
  note "$PW_CONFIG already exists — skipping."
else
  note "Writing $PW_CONFIG..."
  cat >"$PW_CONFIG" <<'EOF'
// Playwright config for the harness's e2e-verify phase.
//
// Runs against a freshly-booted `next dev` on port 3100 (separate
// from the operator's local dev on 3000 so the two don't contend).
// Chromium only — Webkit / Firefox deferred until a specific plan
// demands them.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? "3100");
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const webServerEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: "development",
  PORT: String(PORT),
  E2E_PORT: String(PORT),
  NEXT_DIST_DIR: ".next-e2e",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --port " + PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: webServerEnv,
  },
});
EOF
fi

# ---------------------------------------------------------------------------
# 3. Write heavy-smoke test suite (if not already present)
# ---------------------------------------------------------------------------
mkdir -p "$TESTS_DIR"
if [[ -f "$SMOKE_SPEC" ]]; then
  note "$SMOKE_SPEC already exists — skipping."
else
  note "Writing $SMOKE_SPEC..."
  cat >"$SMOKE_SPEC" <<'EOF'
// Heavy-smoke test suite for the scaffold itself.
//
// This file is the "does the app boot and render at all" check that
// every plan's e2e-verify phase depends on. It asserts only
// structural properties of the scaffold; anything product-specific
// belongs in per-plan tests at tests/e2e/NNNN-*.spec.ts.
//
// If these fail, the app is not deployable and no plan should ship.

import { test, expect } from "@playwright/test";

test.describe("Scaffold smoke", () => {
  test("landing page returns 200 and HTML document", async ({
    page,
    request,
  }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("<html");

    const navResponse = await page.goto("/");
    expect(navResponse?.status()).toBe(200);
  });

  test("html document hydrates without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(
      errors,
      `Unexpected console errors during hydration:\n${errors.join("\n")}`,
    ).toEqual([]);
  });

  test("body has visible content (not a blank page)", async ({ page }) => {
    await page.goto("/");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.trim().length).toBeGreaterThan(0);
  });
});
EOF
fi

# ---------------------------------------------------------------------------
# 4. Wire `e2e` + `e2e:install` scripts into package.json files
# ---------------------------------------------------------------------------
WEB_PKG_NAME="$(node -p "require('./$WEB_DIR/package.json').name")"

ensure_script() {
  local pkg_path="$1" key="$2" value="$3"
  local existing
  existing=$(node -p "JSON.stringify(require('./$pkg_path').scripts && require('./$pkg_path').scripts['$key'] || '')" 2>/dev/null || echo "\"\"")
  if [[ "$existing" == "\"\"" ]] || [[ "$existing" == '""' ]]; then
    note "Adding scripts.$key to $pkg_path"
    npm pkg set "scripts.$key=$value" --prefix "$(dirname "$pkg_path")" >/dev/null 2>&1 || \
      node -e "
        const fs = require('fs');
        const p = './$pkg_path';
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        d.scripts = d.scripts || {};
        d.scripts['$key'] = '$value';
        fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      "
  else
    note "scripts.$key already set in $pkg_path — skipping."
  fi
}

ensure_script "$WEB_DIR/package.json" "e2e" "playwright test"
ensure_script "$WEB_DIR/package.json" "e2e:install" "playwright install --with-deps chromium"
ensure_script "package.json" "e2e" "npm run e2e --workspace $WEB_PKG_NAME"
ensure_script "package.json" "e2e:install" "npm run e2e:install --workspace $WEB_PKG_NAME"

# ---------------------------------------------------------------------------
# 5. Gitignore Playwright artifacts
# ---------------------------------------------------------------------------
for entry in "playwright-report/" "test-results/" ".next-e2e/"; do
  if ! grep -qxF "$entry" .gitignore 2>/dev/null; then
    note "Adding $entry to .gitignore"
    echo "$entry" >> .gitignore
  fi
done

# ---------------------------------------------------------------------------
# 6. Smoke-test the setup by running the suite once
# ---------------------------------------------------------------------------
note "Running smoke tests to verify setup..."
if npm run e2e >/dev/null 2>&1; then
  note "✓ e2e smoke suite passes. Scaffold is ready."
else
  echo ""
  echo "WARN: smoke tests did not pass on first run. This often means:"
  echo "  - The dev server couldn't bind to port 3100 (another process may be using it)"
  echo "  - Your $WEB_DIR/src/app/page.tsx returns empty or errors on load"
  echo "  - Missing dev dependencies"
  echo ""
  echo "Run \`npm run e2e\` from the repo root to see the full output."
  exit 1
fi
