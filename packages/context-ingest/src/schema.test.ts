import { describe, expect, it } from "vitest";

import { contextHeaderSchema, isValidScope, scopePriority } from "./schema.ts";

describe("isValidScope", () => {
  it("accepts the documented scope grammar", () => {
    expect(isValidScope("all")).toBe(true);
    expect(isValidScope("planner")).toBe(true);
    expect(isValidScope("run:0041")).toBe(true);
    expect(isValidScope("phase:CMO")).toBe(true);
    expect(isValidScope("phase:Brand polish")).toBe(true);
  });

  it("rejects malformed scopes", () => {
    expect(isValidScope("")).toBe(false);
    expect(isValidScope("everyone")).toBe(false);
    expect(isValidScope("run:41")).toBe(false);
    expect(isValidScope("run:0041-extra")).toBe(false);
    expect(isValidScope("phase:")).toBe(false);
    expect(isValidScope("phase:with!bangs")).toBe(false);
  });
});

describe("scopePriority", () => {
  it("orders all > phase > planner > run", () => {
    expect(scopePriority("all")).toBeLessThan(scopePriority("phase:CMO"));
    expect(scopePriority("phase:CMO")).toBeLessThan(scopePriority("planner"));
    expect(scopePriority("planner")).toBeLessThan(scopePriority("run:0041"));
  });
});

describe("contextHeaderSchema", () => {
  it("accepts documented sources + scopes", () => {
    const parsed = contextHeaderSchema.parse({
      source: "slack",
      scope: "run:0051",
    });
    expect(parsed).toEqual({ source: "slack", scope: "run:0051" });
  });

  it("rejects an unknown source", () => {
    expect(() =>
      contextHeaderSchema.parse({ source: "x-twitter", scope: "all" }),
    ).toThrow();
  });

  it("rejects an unknown scope grammar", () => {
    expect(() =>
      contextHeaderSchema.parse({ source: "slack", scope: "everyone" }),
    ).toThrow();
  });

  it("rejects unknown frontmatter keys", () => {
    expect(() =>
      contextHeaderSchema.parse({
        source: "slack",
        scope: "all",
        priority: "high",
      }),
    ).toThrow();
  });
});
