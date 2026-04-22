import { describe, expect, it } from "vitest";

import { AcceptanceParseError, parseAcceptanceContent } from "./parser.ts";

const FILE = "/tmp/EXAMPLE.acceptance.md";

describe("parseAcceptanceContent", () => {
  it("parses a minimal valid file", () => {
    const text = [
      "# Acceptance — Example",
      "",
      "## Release criteria",
      "",
      '- [ ] **tag: `auth/google-signin`** — "An operator can sign in with Google."',
      "  - Tested by: `apps/web/e2e/signin.spec.ts`",
      "  - Covered by plans: 0004, 0006",
      "  - Required connections: Google OAuth",
      "",
      "## Environment requirements",
      "",
      "- `DATABASE_URL` (Postgres)",
      "- `OPENAI_API_KEY`, `AUTH_SECRET`",
      "",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.title).toBe("Acceptance — Example");
    expect(spec.criteria).toHaveLength(1);
    const c = spec.criteria[0]!;
    expect(c.tag).toBe("auth/google-signin");
    expect(c.description).toBe("An operator can sign in with Google.");
    expect(c.testedBy).toEqual(["apps/web/e2e/signin.spec.ts"]);
    expect(c.coveredByPlans).toEqual(["0004", "0006"]);
    expect(c.requiredConnections).toEqual(["Google OAuth"]);
    expect(spec.environmentRequirements).toEqual([
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "AUTH_SECRET",
    ]);
  });

  it("parses multiple criteria and preserves order", () => {
    const text = [
      "# Acceptance",
      "",
      "## Release criteria",
      "",
      "- [ ] **tag: `a/one`** — one",
      "- [ ] **tag: `b/two`** — two",
      "  - Tested by: `a.spec.ts`",
      "- [ ] **tag: `c/three`** — three",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.criteria.map((c) => c.tag)).toEqual([
      "a/one",
      "b/two",
      "c/three",
    ]);
    expect(spec.criteria[1]!.testedBy).toEqual(["a.spec.ts"]);
  });

  it("ignores comments and prose inside sections", () => {
    const text = [
      "# Acceptance",
      "",
      "## Release criteria",
      "",
      "Some prose the operator added.",
      "",
      "<!-- HTML comment -->",
      "",
      "- [ ] **tag: `x/y`** — description",
      "",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.criteria).toHaveLength(1);
    expect(spec.criteria[0]!.tag).toBe("x/y");
  });

  it("throws when release criteria section is missing", () => {
    const text = "# Acceptance\n\n## Something Else\n\n- item\n";
    expect(() => parseAcceptanceContent(FILE, text)).toThrow(
      AcceptanceParseError,
    );
  });

  it("throws on duplicate tags with clear location info", () => {
    const text = [
      "## Release criteria",
      "",
      "- [ ] **tag: `dup`** — first",
      "- [ ] **tag: `dup`** — second",
      "",
    ].join("\n");
    expect(() => parseAcceptanceContent(FILE, text)).toThrow(/duplicate tag/u);
  });

  it("throws on a top-level bullet without a tag header", () => {
    const text = [
      "## Release criteria",
      "",
      "- a freeform bullet with no tag",
      "",
    ].join("\n");
    expect(() => parseAcceptanceContent(FILE, text)).toThrow(
      /must start with/u,
    );
  });

  it("throws on a sub-bullet without a parent criterion", () => {
    const text = [
      "## Release criteria",
      "",
      "  - Tested by: `a.spec.ts`",
      "",
    ].join("\n");
    expect(() => parseAcceptanceContent(FILE, text)).toThrow(
      /sub-bullet without a parent/u,
    );
  });

  it("supports checkbox-free bullets and missing sub-keys", () => {
    const text = [
      "## Release criteria",
      "",
      "- **tag: `bare`** — no checkbox",
      "",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.criteria[0]!.tag).toBe("bare");
    expect(spec.criteria[0]!.description).toBe("no checkbox");
  });

  it("strips wrapping quotes from the description", () => {
    const text = [
      "## Release criteria",
      "",
      "- [ ] **tag: `q`** — 'single-quoted description'",
      '- [ ] **tag: `q2`** — "double-quoted description"',
      "- [ ] **tag: `q3`** — unquoted description",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.criteria[0]!.description).toBe("single-quoted description");
    expect(spec.criteria[1]!.description).toBe("double-quoted description");
    expect(spec.criteria[2]!.description).toBe("unquoted description");
  });

  it("dedupes and preserves order for env requirements", () => {
    const text = [
      "## Release criteria",
      "",
      "- [ ] **tag: `a`** — x",
      "",
      "## Environment requirements",
      "",
      "- `FOO_BAR`",
      "- `BAZ`, `FOO_BAR`",
      "- not inline code, skipped",
      "- lowercase `ignored_identifier` is not an env var",
      "",
    ].join("\n");
    const spec = parseAcceptanceContent(FILE, text);
    expect(spec.environmentRequirements).toEqual(["FOO_BAR", "BAZ"]);
  });
});
