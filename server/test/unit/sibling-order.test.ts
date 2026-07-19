import { describe, expect, it } from "vitest";
import { midpointOrder, spreadBetween } from "../../src/services/siblingOrder.js";

// Issue #157 (ADR-43): the pure position math behind the reorder endpoint and
// split-in-place placement. The DB-touching reorderSibling (midpoint write vs
// renormalize) is exercised over HTTP in reorder-subtask.test.ts; these pin the
// arithmetic cheaply, including the REAL-precision underflow that forces a
// renormalize.

describe("midpointOrder", () => {
  it("returns the first position for an empty breakdown", () => {
    expect(midpointOrder(null, null)).toBe(1);
  });

  it("appends past the last sibling (after = null) with a unit gap, never underflowing", () => {
    expect(midpointOrder(5, null)).toBe(6);
    expect(midpointOrder(0.5, null)).toBe(1.5);
  });

  it("bisects toward the front (before = null) staying above the 0 sentinel", () => {
    expect(midpointOrder(null, 10)).toBe(5);
    expect(midpointOrder(null, 1)).toBe(0.5);
    // Never reaches 0 — a front insert stays a legitimate (> 0) position.
    expect(midpointOrder(null, 10)! > 0).toBe(true);
  });

  it("returns the exact midpoint between two neighbors", () => {
    expect(midpointOrder(4, 6)).toBe(5);
    expect(midpointOrder(4, 5)).toBe(4.5);
    const mid = midpointOrder(1, 1 + 2 * Number.EPSILON)!;
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(1 + 2 * Number.EPSILON);
  });

  it("signals underflow (null) when no REAL value fits strictly between the neighbors", () => {
    // Adjacent doubles: the midpoint rounds back onto a neighbor, so there is
    // no representable value between them — the caller must renormalize.
    expect(midpointOrder(1, 1 + Number.EPSILON)).toBeNull();
  });
});

describe("spreadBetween", () => {
  it("spreads n values with unit gaps past an open end (after = null)", () => {
    expect(spreadBetween(5, null, 3)).toEqual([6, 7, 8]);
    expect(spreadBetween(5, null, 1)).toEqual([6]);
  });

  it("spreads n evenly-spaced values strictly inside (before, after), in order", () => {
    expect(spreadBetween(5, 9, 3)).toEqual([6, 7, 8]);
    const parts = spreadBetween(5, 6, 2);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBeGreaterThan(5);
    expect(parts[1]).toBeLessThan(6);
    expect(parts[0]).toBeLessThan(parts[1]); // array order preserved
  });
});
