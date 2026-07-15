import { describe, expect, it } from "vitest";
import { breakdownSchema } from "../../src/aiSchemas.js";

// #23: the AI breakdown's structured output must carry orderMatters — the
// client pre-sets the "Do in order" toggle from it. The live messages.parse
// path cannot run in tests (degraded mode), so the zod contract itself is
// the property that gets pinned.
describe("breakdownSchema orderMatters", () => {
  const base = {
    subtasks: [{ title: "Open the doc", effortMinutes: 10, impact: 3, rationale: "start" }],
    approachNote: "one step at a time",
  };

  it("accepts both judgments", () => {
    expect(breakdownSchema.parse({ ...base, orderMatters: true }).orderMatters).toBe(true);
    expect(breakdownSchema.parse({ ...base, orderMatters: false }).orderMatters).toBe(false);
  });

  it("is required — a response without it must fail parsing, not default silently", () => {
    expect(breakdownSchema.safeParse(base).success).toBe(false);
  });
});
