import { describe, expect, it } from "vitest";
import { isRestorable, type RestorableTask } from "../../src/services/drawService.js";

// Pure restore-validation for the persisted current draw (issue #25) —
// must mirror the drawable predicate (ADR-2) / the client's classifyTask.

function task(overrides: Partial<RestorableTask> = {}): RestorableTask {
  return { status: "open", effortMinutes: 20, hasOpenChildren: 0, ...overrides };
}

describe("isRestorable", () => {
  it("accepts an open leaf task estimated within the limit", () => {
    expect(isRestorable(task(), 30)).toBe(true);
  });

  it("accepts effort exactly at the limit (boundary)", () => {
    expect(isRestorable(task({ effortMinutes: 30 }), 30)).toBe(true);
    expect(isRestorable(task({ effortMinutes: 31 }), 30)).toBe(false);
  });

  it("rejects tasks completed or archived elsewhere", () => {
    expect(isRestorable(task({ status: "done" }), 30)).toBe(false);
    expect(isRestorable(task({ status: "archived" }), 30)).toBe(false);
  });

  it("rejects a task whose estimate was cleared", () => {
    expect(isRestorable(task({ effortMinutes: null }), 30)).toBe(false);
  });

  it("rejects a task edited above the draw limit", () => {
    expect(isRestorable(task({ effortMinutes: 90 }), 30)).toBe(false);
  });

  it("rejects a task that became a container (open subtasks added)", () => {
    expect(isRestorable(task({ hasOpenChildren: 1 }), 30)).toBe(false);
  });

  it("respects a custom draw limit, like the deck itself", () => {
    expect(isRestorable(task({ effortMinutes: 45 }), 60)).toBe(true);
    expect(isRestorable(task({ effortMinutes: 45 }), 30)).toBe(false);
  });
});
