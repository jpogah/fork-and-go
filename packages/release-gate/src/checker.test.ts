import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Plan } from "@fork-and-go/plan-graph";

import { checkAcceptance, parseEnvTemplate } from "./checker.ts";
import { parseAcceptanceContent } from "./parser.ts";

function makePlan(partial: Partial<Plan>): Plan {
  return {
    id: partial.id ?? "0099",
    title: partial.title ?? "Test Plan",
    phase: partial.phase ?? "Harness",
    status: partial.status ?? "completed",
    dependsOn: partial.dependsOn ?? [],
    estimatedPasses: partial.estimatedPasses ?? 1,
    acceptanceTags: partial.acceptanceTags ?? [],
    location: partial.location ?? "completed",
    filePath: partial.filePath ?? "/tmp/0099-x.md",
    body: partial.body ?? "",
    raw: partial.raw ?? {
      id: partial.id ?? "0099",
      title: partial.title ?? "Test Plan",
      phase: partial.phase ?? "Harness",
      status: partial.status ?? "completed",
      depends_on: [],
      estimated_passes: 1,
      acceptance_tags: partial.acceptanceTags ?? [],
    },
  };
}

describe("checkAcceptance", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "release-gate-checker-"));
    mkdirSync(path.join(tmp, "tests"), { recursive: true });
    writeFileSync(path.join(tmp, "tests", "signin.spec.ts"), "// test\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const specText = (extraCriteria = ""): string =>
    [
      "# Acceptance",
      "",
      "## Release criteria",
      "",
      '- [ ] **tag: `auth/google-signin`** — "signin"',
      "  - Tested by: `tests/signin.spec.ts`",
      extraCriteria,
      "",
      "## Environment requirements",
      "",
      "- `DATABASE_URL`",
      "- `AUTH_SECRET`",
      "",
    ]
      .filter(Boolean)
      .join("\n");

  const envTemplate = [
    "DATABASE_URL=postgres://x:y@localhost/db",
    "AUTH_SECRET=",
  ].join("\n");

  it("marks criterion covered when a completed plan claims the tag", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const plans = [
      makePlan({
        id: "0004",
        status: "completed",
        acceptanceTags: ["auth/google-signin"],
      }),
    ];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: envTemplate,
      repoRoot: tmp,
    });
    expect(result.criteria[0]!.status).toBe("covered");
    expect(result.criteria[0]!.coveringPlans.map((p) => p.id)).toEqual([
      "0004",
    ]);
    // Env: DATABASE_URL has a real default, AUTH_SECRET is empty (placeholder).
    expect(result.environment.map((e) => e.status)).toEqual([
      "set",
      "placeholder",
    ]);
    expect(result.passed).toBe(false);
  });

  it("marks criterion uncovered when no plan has the tag", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const result = await checkAcceptance({
      spec,
      plans: [],
      envTemplateContent: envTemplate.replace(
        "AUTH_SECRET=",
        "AUTH_SECRET=xyz",
      ),
      repoRoot: tmp,
    });
    expect(result.criteria[0]!.status).toBe("uncovered");
    expect(result.passed).toBe(false);
  });

  it("rejects an active-only plan (must be completed)", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const plans = [
      makePlan({
        id: "0004",
        status: "active",
        location: "active",
        acceptanceTags: ["auth/google-signin"],
      }),
    ];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: envTemplate.replace("AUTH_SECRET=", "AUTH_SECRET=ok"),
      repoRoot: tmp,
    });
    expect(result.criteria[0]!.status).toBe("uncovered");
    // But the covering-plans list still names the active plan so the report
    // can tell the operator "you have a plan coming but it's not merged yet."
    expect(result.criteria[0]!.coveringPlans[0]?.status).toBe("active");
  });

  it("flags a missing test file", async () => {
    const spec = parseAcceptanceContent(
      "spec.md",
      specText(
        "- [ ] **tag: `x/y`** — x\n  - Tested by: `tests/does-not-exist.spec.ts`",
      ),
    );
    const plans = [
      makePlan({
        status: "completed",
        acceptanceTags: ["auth/google-signin", "x/y"],
      }),
    ];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: envTemplate.replace("AUTH_SECRET=", "AUTH_SECRET=ok"),
      repoRoot: tmp,
    });
    const byTag = new Map(result.criteria.map((c) => [c.tag, c]));
    expect(byTag.get("auth/google-signin")!.status).toBe("covered");
    expect(byTag.get("x/y")!.status).toBe("covered-but-test-missing");
    expect(byTag.get("x/y")!.missingTestPaths).toEqual([
      "tests/does-not-exist.spec.ts",
    ]);
    expect(result.passed).toBe(false);
  });

  it("runs tests when a runner is supplied", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const plans = [
      makePlan({ status: "completed", acceptanceTags: ["auth/google-signin"] }),
    ];
    const runs: string[] = [];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: envTemplate.replace("AUTH_SECRET=", "AUTH_SECRET=ok"),
      repoRoot: tmp,
      runTest: (p) => {
        runs.push(p);
        return {
          testPath: p,
          ok: true,
          durationMs: 10,
          output: "",
          command: "noop",
        };
      },
    });
    expect(runs).toEqual(["tests/signin.spec.ts"]);
    expect(result.criteria[0]!.status).toBe("covered");
    expect(result.passed).toBe(true);
  });

  it("surfaces a failing test as covered-but-test-failed", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const plans = [
      makePlan({ status: "completed", acceptanceTags: ["auth/google-signin"] }),
    ];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: envTemplate.replace("AUTH_SECRET=", "AUTH_SECRET=ok"),
      repoRoot: tmp,
      runTest: () => ({
        testPath: "tests/signin.spec.ts",
        ok: false,
        durationMs: 15,
        output: "boom",
        command: "noop",
      }),
    });
    expect(result.criteria[0]!.status).toBe("covered-but-test-failed");
    expect(result.criteria[0]!.testRun?.output).toBe("boom");
    expect(result.passed).toBe(false);
  });

  it("reports a missing env var distinct from a placeholder", async () => {
    const spec = parseAcceptanceContent(
      "spec.md",
      [
        "## Release criteria",
        "",
        "- [ ] **tag: `a/b`** — a",
        "",
        "## Environment requirements",
        "",
        "- `DATABASE_URL`",
        "- `MISSING_FROM_TEMPLATE`",
        "- `IS_PLACEHOLDER`",
        "",
      ].join("\n"),
    );
    const template = [
      "DATABASE_URL=postgres://ok",
      "IS_PLACEHOLDER=changeme",
    ].join("\n");
    const plans = [makePlan({ status: "completed", acceptanceTags: ["a/b"] })];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: template,
      repoRoot: tmp,
    });
    const byName = new Map(result.environment.map((e) => [e.name, e]));
    expect(byName.get("DATABASE_URL")!.status).toBe("set");
    expect(byName.get("MISSING_FROM_TEMPLATE")!.status).toBe(
      "missing-from-template",
    );
    expect(byName.get("IS_PLACEHOLDER")!.status).toBe("placeholder");
    expect(result.passed).toBe(false);
  });

  it("passes when every criterion covered and every env var set", async () => {
    const spec = parseAcceptanceContent("spec.md", specText());
    const template = ["DATABASE_URL=postgres://ok", "AUTH_SECRET=shhh"].join(
      "\n",
    );
    const plans = [
      makePlan({ status: "completed", acceptanceTags: ["auth/google-signin"] }),
    ];
    const result = await checkAcceptance({
      spec,
      plans,
      envTemplateContent: template,
      repoRoot: tmp,
    });
    expect(result.passed).toBe(true);
  });
});

describe("parseEnvTemplate", () => {
  it("parses key=value and skips comments / blanks", () => {
    const text = [
      "# comment",
      "",
      "FOO=bar",
      'BAZ="quoted value"',
      "EMPTY=",
      "IGNORED lowercase",
      "lowercase_ignored=x",
    ].join("\n");
    const map = parseEnvTemplate(text);
    expect(map.get("FOO")?.kind).toBe("set");
    expect(map.get("BAZ")?.raw).toBe("quoted value");
    expect(map.get("EMPTY")?.kind).toBe("empty");
    expect(map.has("lowercase_ignored")).toBe(false);
  });
});
