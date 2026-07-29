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

  // #209: Split is no longer scoped to too-big rows, so the pre-fill now has
  // to cope with an estimate the size arithmetic would satisfy in one part.
  describe("minParts", () => {
    it("floors the count so an under-the-limit estimate still seeds a real split", () => {
      const parts = evenSplitPlan("Upload the assets", 15, 30, 2);
      expect(parts).toEqual([
        { title: "Upload the assets (part 1/2)", effortMinutes: 8 },
        { title: "Upload the assets (part 2/2)", effortMinutes: 7 },
      ]);
      // The invariant survives the floor: splitting never rewrites the total.
      expect(parts.reduce((sum, p) => sum + p.effortMinutes, 0)).toBe(15);
    });

    it("never LOWERS a count the size arithmetic already justifies", () => {
      // 90 over a 30 limit needs three parts; asking for two cannot shrink it.
      expect(evenSplitPlan("Long", 90, 30, 2)).toHaveLength(3);
    });

    it("still yields to MAX_SPLIT_PARTS", () => {
      expect(evenSplitPlan("Monster", 600, 30, 20)).toHaveLength(MAX_SPLIT_PARTS);
    });

    it("defaults to 1, leaving the server mirror's arithmetic untouched", () => {
      expect(evenSplitPlan("Small", 15, 30)).toEqual([
        { title: "Small (part 1/1)", effortMinutes: 15 },
      ]);
    });
  });
});
