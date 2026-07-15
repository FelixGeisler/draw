import { describe, expect, it } from "vitest";
import { seedInOrder, sequentialLockedByRecurrence } from "./orderMode";

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

// #66 (ADR-23): a recurring subtask locks the switch to 'sequential' — the
// API rejects the transition, so the UI disables it with the reason instead.
describe("sequentialLockedByRecurrence", () => {
  it("locks a parallel parent that has a recurring subtask", () => {
    expect(
      sequentialLockedByRecurrence([{ recurEveryDays: null }, { recurEveryDays: 3 }], "parallel"),
    ).toBe(true);
  });

  it("does not lock without any recurring subtask", () => {
    expect(sequentialLockedByRecurrence([{ recurEveryDays: null }], "parallel")).toBe(false);
    expect(sequentialLockedByRecurrence([], "parallel")).toBe(false);
    expect(sequentialLockedByRecurrence(undefined, "parallel")).toBe(false);
  });

  it("never locks an already-sequential parent — resending its mode is a no-op, and flipping away repairs a pre-ban combo", () => {
    expect(sequentialLockedByRecurrence([{ recurEveryDays: 3 }], "sequential")).toBe(false);
  });
});
