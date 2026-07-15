import { describe, expect, it } from "vitest";
import { isRestorable, type RestorableTask } from "../../src/services/drawService.js";

// Pure restore-validation for the persisted current draw (issue #25) —
// must mirror the drawable predicate (ADR-2) / the client's classifyTask.
// The snooze/block dimension (#19) is additionally pinned against the client
// via the shared vectors in drawable-vectors.test.ts.

const NOW = new Date("2026-07-14T12:00:00.000Z");

function task(overrides: Partial<RestorableTask> = {}): RestorableTask {
  return {
    status: "open",
    effortMinutes: 20,
    hasOpenChildren: 0,
    blocked: 0,
    deferredUntil: null,
    heldBack: 0,
    ...overrides,
  };
}

describe("isRestorable", () => {
  it("accepts an open leaf task estimated within the limit", () => {
    expect(isRestorable(task(), 30, NOW)).toBe(true);
  });

  it("accepts effort exactly at the limit (boundary)", () => {
    expect(isRestorable(task({ effortMinutes: 30 }), 30, NOW)).toBe(true);
    expect(isRestorable(task({ effortMinutes: 31 }), 30, NOW)).toBe(false);
  });

  it("rejects tasks completed or archived elsewhere", () => {
    expect(isRestorable(task({ status: "done" }), 30, NOW)).toBe(false);
    expect(isRestorable(task({ status: "archived" }), 30, NOW)).toBe(false);
  });

  it("rejects a task whose estimate was cleared", () => {
    expect(isRestorable(task({ effortMinutes: null }), 30, NOW)).toBe(false);
  });

  it("rejects a task edited above the draw limit", () => {
    expect(isRestorable(task({ effortMinutes: 90 }), 30, NOW)).toBe(false);
  });

  it("rejects a task that became a container (open subtasks added)", () => {
    expect(isRestorable(task({ hasOpenChildren: 1 }), 30, NOW)).toBe(false);
  });

  it("respects a custom draw limit, like the deck itself", () => {
    expect(isRestorable(task({ effortMinutes: 45 }), 60, NOW)).toBe(true);
    expect(isRestorable(task({ effortMinutes: 45 }), 30, NOW)).toBe(false);
  });

  // #19: a snoozed or blocked card left the deck — never restore it. SQLite
  // hands blocked over as 0/1, so both representations must behave.
  it("rejects a blocked task (0/1 and boolean forms)", () => {
    expect(isRestorable(task({ blocked: 1 }), 30, NOW)).toBe(false);
    expect(isRestorable(task({ blocked: true }), 30, NOW)).toBe(false);
  });

  it("rejects a task snoozed into the future, accepts one already woken", () => {
    expect(isRestorable(task({ deferredUntil: "2026-07-14T13:00:00.000Z" }), 30, NOW)).toBe(false);
    expect(isRestorable(task({ deferredUntil: "2026-07-14T11:00:00.000Z" }), 30, NOW)).toBe(true);
    // Boundary: deferredUntil exactly now counts as woken, like the SQL `<=`.
    expect(isRestorable(task({ deferredUntil: NOW.toISOString() }), 30, NOW)).toBe(true);
  });

  // #23: a drawn card that fell behind a sequential sibling (parent toggled,
  // or an older sibling reopened) left the deck — never restore it. SQLite
  // hands the derived heldBack over as 0/1, so both representations count.
  it("rejects a held-back sequential sibling (0/1 and boolean forms)", () => {
    expect(isRestorable(task({ heldBack: 1 }), 30, NOW)).toBe(false);
    expect(isRestorable(task({ heldBack: true }), 30, NOW)).toBe(false);
  });
});
