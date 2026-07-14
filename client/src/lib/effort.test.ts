import { describe, expect, it } from "vitest";
import { displayEffort } from "./effort";

// Pins the effort chip's source of truth (issue #15 / PR #26 follow-up):
// the derived remaining effort wins whenever the task shape carries it,
// even when it is null — null means "open subtasks, none estimated" and
// must hide the chip rather than resurface the stale own estimate.
describe("displayEffort", () => {
  it("falls back to the own estimate when the field is absent (drawn card, timer bar)", () => {
    expect(displayEffort({ effortMinutes: 20 })).toBe(20);
    expect(displayEffort({ effortMinutes: null })).toBeNull();
  });

  it("returns null when present-but-null, ignoring the stored own estimate", () => {
    expect(displayEffort({ effortMinutes: 90, remainingEffortMinutes: null })).toBeNull();
  });

  it("returns the derived number when the API provides one", () => {
    expect(displayEffort({ effortMinutes: 90, remainingEffortMinutes: 40 })).toBe(40);
    expect(displayEffort({ effortMinutes: null, remainingEffortMinutes: 15 })).toBe(15);
  });
});
