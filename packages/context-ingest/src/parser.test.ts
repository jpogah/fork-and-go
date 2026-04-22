import { describe, expect, it } from "vitest";

import { parseContextFile } from "./parser.ts";

function withFrontmatter(header: string, body: string): string {
  return `---\n${header}\n---\n\n${body}`;
}

describe("parseContextFile", () => {
  it("parses a valid context file", () => {
    const text = withFrontmatter(
      `source: "slack"\nscope: "run:0041"`,
      "Max price is $49/mo per seat.",
    );
    const result = parseContextFile("2026-04-21-pricing.md", text, 12_345);
    if (!result.ok)
      throw new Error(`expected ok, got ${result.warning.reason}`);
    expect(result.file.header).toEqual({
      source: "slack",
      scope: "run:0041",
    });
    expect(result.file.body).toBe("Max price is $49/mo per seat.");
    expect(result.file.mtimeMs).toBe(12_345);
    expect(result.file.filename).toBe("2026-04-21-pricing.md");
  });

  it("returns a warning when the frontmatter delimiter is missing", () => {
    const result = parseContextFile("bad.md", "not a frontmatter", 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.reason).toMatch(/expected YAML frontmatter/u);
  });

  it("returns a warning when the frontmatter is unterminated", () => {
    const result = parseContextFile(
      "bad.md",
      `---\nsource: "slack"\nscope: "all"\nbody with no closing delimiter`,
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.reason).toMatch(/unterminated/u);
  });

  it("returns a warning when YAML is malformed", () => {
    const result = parseContextFile(
      "bad.md",
      `---\n:not:valid:yaml:\n---\nbody`,
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.reason).toMatch(/YAML|validation|scope|source/u);
  });

  it("returns a warning when scope is unknown", () => {
    const text = withFrontmatter(`source: "slack"\nscope: "everyone"`, "body");
    const result = parseContextFile("bad.md", text, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.reason).toMatch(/scope/u);
  });

  it("returns a warning when source is unknown", () => {
    const text = withFrontmatter(`source: "x-twitter"\nscope: "all"`, "body");
    const result = parseContextFile("bad.md", text, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.reason).toMatch(/source/u);
  });

  it("strips leading blank lines from the body", () => {
    const text = `---\nsource: "slack"\nscope: "all"\n---\n\n\nfirst line`;
    const result = parseContextFile("a.md", text, 0);
    if (!result.ok) throw new Error(result.warning.reason);
    expect(result.file.body.startsWith("first line")).toBe(true);
  });
});
