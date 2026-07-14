import { describe, expect, it } from "vitest";
import { resolveSubmittedImpact } from "./impact";

// Pins the TaskForm submit payload's impact resolution. The drawn-card edit
// (issue #13) made TaskForm an update path: editing a goal-less task must
// keep its stored impact instead of resetting it to the default 3 — the
// picker is hidden for goal-less tasks, so a reset would be invisible while
// still changing the task's draw weight (impact²) and stats bucket.
describe("resolveSubmittedImpact", () => {
  it("uses the picked impact when a goal is selected", () => {
    expect(resolveSubmittedImpact(7, 4)).toBe(4);
    expect(resolveSubmittedImpact(7, 4, { goalId: 7, impact: 2 })).toBe(4);
  });

  it("defaults to 3 when creating without a goal", () => {
    expect(resolveSubmittedImpact("", 5)).toBe(3);
  });

  it("preserves the stored impact when editing a goal-less task", () => {
    expect(resolveSubmittedImpact("", 3, { goalId: null, impact: 5 })).toBe(5);
    expect(resolveSubmittedImpact("", 3, { goalId: null, impact: 1 })).toBe(1);
  });

  it("falls back to 3 when a goal-less task has no stored impact", () => {
    expect(resolveSubmittedImpact("", 5, { goalId: null })).toBe(3);
  });

  it("resets to 3 when the goal is deliberately unlinked", () => {
    expect(resolveSubmittedImpact("", 5, { goalId: 7, impact: 5 })).toBe(3);
  });
});
