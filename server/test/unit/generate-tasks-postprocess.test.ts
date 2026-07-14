import { describe, expect, it } from "vitest";
import {
  capAndClean,
  evenSplit,
  MAX_ITEMS,
  MAX_PARTS_PER_ITEM,
  normalizeImpacts,
  postprocessGenerateTasks,
  splitOversized,
  type GeneratedTask,
} from "../../src/services/aiPostprocess.js";

let nextId = 1;
function task(overrides: Partial<GeneratedTask> = {}): GeneratedTask {
  const id = nextId++;
  return {
    label: String(id),
    title: `Solve exercise ${id}`,
    points: null,
    statedMinutes: null,
    estimatedMinutes: 20,
    suggestedImpact: 3,
    rationale: `Ex. ${id} per the PDF`,
    parts: [],
    ...overrides,
  };
}

describe("normalizeImpacts (points → impact quintiles)", () => {
  it("maps five distinct point values onto the full 1-5 range, flagged as points-derived", () => {
    const tasks = [10, 20, 30, 40, 50].map((points) => task({ points }));
    const rated = normalizeImpacts(tasks);
    expect(rated.map((t) => t.impact)).toEqual([1, 2, 3, 4, 5]);
    expect(rated.every((t) => t.impactSource === "points")).toBe(true);
  });

  it("assigns quintiles by rank position for ten distinct values", () => {
    const tasks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((points) => task({ points }));
    expect(normalizeImpacts(tasks).map((t) => t.impact)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("is rank-based, not value-proportional: an outlier cannot compress the scale", () => {
    const tasks = [1, 2, 3, 4, 1000].map((points) => task({ points }));
    expect(normalizeImpacts(tasks).map((t) => t.impact)).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives tied point values the same rating", () => {
    const tasks = [10, 10, 50].map((points) => task({ points }));
    const rated = normalizeImpacts(tasks);
    expect(rated[0].impact).toBe(rated[1].impact);
    expect(rated[2].impact).toBe(5);
  });

  it("lands all-equal points on one middle rating (documented behavior, not a bug)", () => {
    const tasks = [7, 7, 7, 7].map((points) => task({ points }));
    const rated = normalizeImpacts(tasks);
    expect(new Set(rated.map((t) => t.impact)).size).toBe(1);
    expect(rated[0].impact).toBe(3);
    expect(rated.every((t) => t.impactSource === "points")).toBe(true);
  });

  it("falls back to the model's rating when fewer than half the items carry points", () => {
    const tasks = [
      task({ points: 12, suggestedImpact: 1 }),
      task({ points: null, suggestedImpact: 4 }),
      task({ points: null, suggestedImpact: 2 }),
    ];
    const rated = normalizeImpacts(tasks);
    expect(rated.map((t) => t.impact)).toEqual([1, 4, 2]);
    expect(rated.every((t) => t.impactSource === "model")).toBe(true);
  });

  it("uses points when exactly half the items carry them; pointless items fall back per-item", () => {
    const tasks = [
      task({ points: 5, suggestedImpact: 1 }),
      task({ points: 40, suggestedImpact: 1 }),
      task({ points: null, suggestedImpact: 4 }),
      task({ points: null, suggestedImpact: 2 }),
    ];
    const rated = normalizeImpacts(tasks);
    expect(rated[0]).toMatchObject({ impact: 2, impactSource: "points" }); // bottom of 2 pointed
    expect(rated[1]).toMatchObject({ impact: 4, impactSource: "points" }); // top of 2 pointed
    expect(rated[2]).toMatchObject({ impact: 4, impactSource: "model" });
    expect(rated[3]).toMatchObject({ impact: 2, impactSource: "model" });
  });

  it("returns an empty list for empty input", () => {
    expect(normalizeImpacts([])).toEqual([]);
  });
});

describe("evenSplit", () => {
  it("preserves the total and spreads the remainder over the first parts", () => {
    expect(evenSplit(70, 3)).toEqual([24, 23, 23]);
    expect(evenSplit(60, 2)).toEqual([30, 30]);
    expect(evenSplit(31, 2)).toEqual([16, 15]);
  });
});

describe("splitOversized (split, don't clamp)", () => {
  it("turns a 60-min item with no parts into 2 parts totaling 60 — never a single clamped 30-min task", () => {
    const split = splitOversized(task({ statedMinutes: 60, estimatedMinutes: 60 }), 30);
    expect(split.parts).toHaveLength(2);
    expect(split.parts.reduce((sum, p) => sum + p.minutes, 0)).toBe(60);
    expect(split.parts.every((p) => p.minutes <= 30)).toBe(true);
    // The material's own data stays verbatim on the item itself.
    expect(split.statedMinutes).toBe(60);
    expect(split.estimatedMinutes).toBe(60);
  });

  it("leaves items at or under the limit untouched", () => {
    const t = task({ statedMinutes: 30, estimatedMinutes: 30 });
    expect(splitOversized(t, 30)).toEqual(t);
    const small = task({ estimatedMinutes: 5 });
    expect(splitOversized(small, 30)).toEqual(small);
  });

  it("splits by estimatedMinutes when the material states no time", () => {
    const split = splitOversized(task({ statedMinutes: null, estimatedMinutes: 70 }), 30);
    expect(split.parts).toHaveLength(3);
    expect(split.parts.reduce((sum, p) => sum + p.minutes, 0)).toBe(70);
    expect(split.parts.every((p) => p.minutes <= 30)).toBe(true);
  });

  it("prefers the material's statedMinutes over the model estimate for the split decision", () => {
    // stated 60 wins over estimated 20: the item is oversized.
    const split = splitOversized(task({ statedMinutes: 60, estimatedMinutes: 20 }), 30);
    expect(split.parts).toHaveLength(2);
    // stated 20 wins over estimated 90: not oversized.
    const kept = splitOversized(task({ statedMinutes: 20, estimatedMinutes: 90 }), 30);
    expect(kept.parts).toEqual([]);
  });

  it("names the generated parts after the item", () => {
    const split = splitOversized(task({ title: "Solve exercise 7", statedMinutes: 60 }), 30);
    expect(split.parts.map((p) => p.title)).toEqual([
      "Solve exercise 7 (part 1/2)",
      "Solve exercise 7 (part 2/2)",
    ]);
  });

  it("keeps model-provided parts as-is (they follow the material's sub-question boundaries)", () => {
    const parts = [
      { title: "7a", minutes: 25 },
      { title: "7b", minutes: 30 },
    ];
    const split = splitOversized(task({ statedMinutes: 55, parts }), 30);
    expect(split.parts).toEqual(parts);
  });

  it("splits a single oversized model part so every leaf stays drawable", () => {
    const split = splitOversized(
      task({
        statedMinutes: 55,
        parts: [
          { title: "7a", minutes: 10 },
          { title: "7b", minutes: 45 },
        ],
      }),
      30,
    );
    expect(split.parts.map((p) => p.title)).toEqual(["7a", "7b (part 1/2)", "7b (part 2/2)"]);
    expect(split.parts.reduce((sum, p) => sum + p.minutes, 0)).toBe(55);
    expect(split.parts.every((p) => p.minutes <= 30)).toBe(true);
  });
});

describe("capAndClean", () => {
  it("caps the item list", () => {
    const tasks = Array.from({ length: MAX_ITEMS + 15 }, () => task());
    expect(capAndClean(tasks)).toHaveLength(MAX_ITEMS);
  });

  it("caps parts per item", () => {
    const parts = Array.from({ length: MAX_PARTS_PER_ITEM + 5 }, (_, i) => ({
      title: `part ${i}`,
      minutes: 10,
    }));
    expect(capAndClean([task({ parts })])[0].parts).toHaveLength(MAX_PARTS_PER_ITEM);
  });

  it("drops empty and whitespace-only titles on items and parts", () => {
    const cleaned = capAndClean([
      task({ title: "" }),
      task({ title: "   " }),
      task({
        title: "  Keep me  ",
        parts: [
          { title: "  ", minutes: 10 },
          { title: " real part ", minutes: 10 },
        ],
      }),
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].title).toBe("Keep me");
    expect(cleaned[0].parts).toEqual([{ title: "real part", minutes: 10 }]);
  });

  it("clamps estimated and part minutes to whole minutes >= 1, but never touches statedMinutes", () => {
    const cleaned = capAndClean([
      task({
        statedMinutes: 0.5,
        estimatedMinutes: 0,
        parts: [{ title: "p", minutes: -3.7 }],
      }),
      task({ estimatedMinutes: 12.4 }),
    ]);
    expect(cleaned[0].estimatedMinutes).toBe(1);
    expect(cleaned[0].parts[0].minutes).toBe(1);
    expect(cleaned[0].statedMinutes).toBe(0.5); // material data stays verbatim
    expect(cleaned[1].estimatedMinutes).toBe(12);
  });
});

describe("postprocessGenerateTasks (full pipeline)", () => {
  it("cleans, rates by points, and splits oversized items in one pass", () => {
    const result = postprocessGenerateTasks(
      {
        sourceOverview: "Mock exam with 4 exercises, 100 points total",
        tasks: [
          task({ title: "  ", points: 99 }), // dropped before rating: must not skew quintiles
          task({ points: 10, statedMinutes: 20 }),
          task({ points: 30, statedMinutes: 45 }),
          task({ points: null, suggestedImpact: 2, estimatedMinutes: 15 }),
          task({ points: 60, statedMinutes: 90 }),
        ],
      },
      30,
    );

    expect(result.sourceOverview).toBe("Mock exam with 4 exercises, 100 points total");
    expect(result.tasks).toHaveLength(4);

    const [low, mid, model, high] = result.tasks;
    expect(low).toMatchObject({ impact: 1, impactSource: "points" });
    expect(mid).toMatchObject({ impact: 3, impactSource: "points" });
    expect(model).toMatchObject({ impact: 2, impactSource: "model" });
    expect(high).toMatchObject({ impact: 5, impactSource: "points" });

    expect(low.parts).toEqual([]); // 20 min fits
    expect(mid.parts).toHaveLength(2); // 45 min → 2 parts
    expect(mid.parts.reduce((sum, p) => sum + p.minutes, 0)).toBe(45);
    expect(high.parts).toHaveLength(3); // 90 min → 3 parts
    expect(high.parts.reduce((sum, p) => sum + p.minutes, 0)).toBe(90);
    expect(high.statedMinutes).toBe(90); // never clamped
  });
});
