import { describe, expect, it } from "vitest";
import { evenSplit, evenSplitPlan, MAX_SPLIT_PARTS } from "./splitPlan";

// Issue #108: the split editor's deterministic pre-fill mirrors the server's
// evenSplit/splitPlan (aiPostprocess.ts, #28) — ceil(minutes / maxEffort)
// near-equal whole-minute parts that preserve the total, capped at 10.

describe("evenSplit", () => {
  it("splits into near-equal whole-minute parts that sum to the total", () => {
    expect(evenSplit(45, 2)).toEqual([23, 22]);
    expect(evenSplit(90, 3)).toEqual([30, 30, 30]);
    expect(evenSplit(31, 2)).toEqual([16, 15]);
  });
});

describe("evenSplitPlan", () => {
  it("produces ceil(minutes / maxEffort) parts preserving the total, labeled part i/n", () => {
    const parts = evenSplitPlan("Write the report", 45, 30);
    expect(parts).toEqual([
      { title: "Write the report (part 1/2)", effortMinutes: 23 },
      { title: "Write the report (part 2/2)", effortMinutes: 22 },
    ]);
    expect(parts.reduce((sum, p) => sum + p.effortMinutes, 0)).toBe(45);
  });

  it("a just-over-the-limit estimate still yields two parts (the minimum split)", () => {
    expect(evenSplitPlan("Barely", 31, 30).map((p) => p.effortMinutes)).toEqual([16, 15]);
  });

  it("caps at MAX_SPLIT_PARTS, letting parts exceed maxEffort — they can be split again", () => {
    const parts = evenSplitPlan("Monster", 600, 30);
    expect(parts).toHaveLength(MAX_SPLIT_PARTS);
    expect(parts.reduce((sum, p) => sum + p.effortMinutes, 0)).toBe(600);
    expect(parts.every((p) => p.effortMinutes === 60)).toBe(true);
  });
});
