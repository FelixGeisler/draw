import { describe, expect, it } from "vitest";
import { seedInOrder } from "./orderMode";

// The AI panel's "Do in order" seed (#67): a re-breakdown must never silently
// flip a parent's persisted subtaskOrderMode — the model's orderMatters only
// pre-sets parents that have no mode yet (no subtasks so far).

describe("seedInOrder", () => {
  it("keeps an already-sequential parent sequential regardless of the model", () => {
    expect(seedInOrder(false, "sequential")).toBe(true);
    expect(seedInOrder(true, "sequential")).toBe(true);
  });

  it("keeps an explicitly-parallel parent parallel regardless of the model", () => {
    expect(seedInOrder(true, "parallel")).toBe(false);
    expect(seedInOrder(false, "parallel")).toBe(false);
  });

  it("lets the model's orderMatters judgment seed a fresh parent", () => {
    expect(seedInOrder(true)).toBe(true);
    expect(seedInOrder(false)).toBe(false);
  });
});
