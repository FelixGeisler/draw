import { describe, expect, it } from "vitest";
import { breakdownAllDone } from "../../src/routes/tasks.js";

// Issue #111 (ADR-32): the all-done predicate that triggers a parent's
// auto-completion — >= 1 done subtask AND zero open ones, archived subtasks
// ignored on both sides. The integration suite exercises the trigger paths
// over HTTP; this pins the pure matrix cheaply.

describe("breakdownAllDone", () => {
  it("is true for all-done breakdowns of any size", () => {
    expect(breakdownAllDone(["done"])).toBe(true);
    expect(breakdownAllDone(["done", "done", "done"])).toBe(true);
  });

  it("is false while any subtask is open", () => {
    expect(breakdownAllDone(["open"])).toBe(false);
    expect(breakdownAllDone(["done", "open"])).toBe(false);
    expect(breakdownAllDone(["open", "open", "done"])).toBe(false);
  });

  it("is false with zero subtasks — a leaf is not an all-done breakdown", () => {
    expect(breakdownAllDone([])).toBe(false);
  });

  it("ignores archived subtasks on the done side: done + archived is all-done", () => {
    // Archiving the last open subtask next to a done sibling triggers the
    // auto-completion — the archived row neither blocks nor counts.
    expect(breakdownAllDone(["done", "archived"])).toBe(true);
    expect(breakdownAllDone(["archived", "done", "archived"])).toBe(true);
  });

  it("ignores archived subtasks on the open side: open + archived stays open", () => {
    expect(breakdownAllDone(["open", "archived"])).toBe(false);
  });

  it("is false when ALL subtasks are archived — zero non-archived children is the leaf case", () => {
    // Rule 1's complement: such a parent completes as an ordinary leaf on
    // its own estimate; there is nothing done to auto-complete "for".
    expect(breakdownAllDone(["archived"])).toBe(false);
    expect(breakdownAllDone(["archived", "archived"])).toBe(false);
  });

  it("split-in-place shape (#108): archived original + open replacements never triggers", () => {
    expect(breakdownAllDone(["archived", "open", "open"])).toBe(false);
    expect(breakdownAllDone(["done", "archived", "open", "open"])).toBe(false);
  });
});
