import { describe, expect, it } from "vitest";
import { buildEstimation, type EstimationInputRow } from "../../src/services/statsService.js";

let nextId = 1;
function row(overrides: Partial<EstimationInputRow> = {}): EstimationInputRow {
  const id = nextId++;
  return {
    taskId: id,
    title: `task ${id}`,
    estimatedMinutes: 30,
    trackedMinutes: 30,
    categoryId: 1,
    categoryName: "Work",
    categoryColor: "#4f8cff",
    ...overrides,
  };
}

describe("buildEstimation", () => {
  it("returns null ratio and tendency (not NaN/Infinity) for empty input", () => {
    const e = buildEstimation([]);
    expect(e.tasks).toEqual([]);
    expect(e.byCategory).toEqual([]);
    expect(e.summary).toEqual({
      taskCount: 0,
      totalEstimatedMinutes: 0,
      totalTrackedMinutes: 0,
      accuracyRatio: null,
      tendency: null,
    });
  });

  it("computes per-task ratio as tracked / estimated", () => {
    const e = buildEstimation([row({ estimatedMinutes: 30, trackedMinutes: 45 })]);
    expect(e.tasks[0].ratio).toBe(1.5);
    expect(e.summary.accuracyRatio).toBe(1.5);
  });

  it.each([
    [89, "over"], // 0.89 < 0.9
    [90, "accurate"], // band is inclusive at 0.9
    [100, "accurate"],
    [110, "accurate"], // band is inclusive at 1.1
    [111, "under"], // 1.11 > 1.1 — took longer, so the estimate was too low
  ])("tracked %i min on a 100 min estimate → tendency %s", (tracked, tendency) => {
    const e = buildEstimation([row({ estimatedMinutes: 100, trackedMinutes: tracked })]);
    expect(e.summary.tendency).toBe(tendency);
  });

  it("applies the band to the rounded ratio", () => {
    // 110.4 / 100 = 1.104 → rounds to 1.1 → still accurate
    const e = buildEstimation([row({ estimatedMinutes: 100, trackedMinutes: 110.4 })]);
    expect(e.summary.accuracyRatio).toBe(1.1);
    expect(e.summary.tendency).toBe("accurate");
  });

  it("aggregates as total tracked over total estimated, not the mean of ratios", () => {
    const e = buildEstimation([
      row({ estimatedMinutes: 10, trackedMinutes: 30 }), // ratio 3.0
      row({ estimatedMinutes: 100, trackedMinutes: 100 }), // ratio 1.0
    ]);
    // mean of ratios would be 2.0 — a tiny task must not dominate
    expect(e.summary.accuracyRatio).toBe(1.18); // 130 / 110, rounded
    expect(e.summary.tendency).toBe("under");
  });

  it("excludes tasks with null or non-positive estimates from rows and totals", () => {
    const e = buildEstimation([
      row({ estimatedMinutes: null, trackedMinutes: 500 }),
      row({ estimatedMinutes: 0, trackedMinutes: 500 }),
      row({ estimatedMinutes: 20, trackedMinutes: 10 }),
    ]);
    expect(e.tasks).toHaveLength(1);
    expect(e.summary).toMatchObject({
      taskCount: 1,
      totalEstimatedMinutes: 20,
      totalTrackedMinutes: 10,
      accuracyRatio: 0.5,
      tendency: "over",
    });
  });

  it("yields null ratio when only estimate-less tasks exist", () => {
    const e = buildEstimation([row({ estimatedMinutes: null, trackedMinutes: 500 })]);
    expect(e.summary.accuracyRatio).toBeNull();
    expect(e.summary.tendency).toBeNull();
  });

  it("rounds tracked minutes for display but derives the ratio from raw minutes", () => {
    const e = buildEstimation([row({ estimatedMinutes: 30, trackedMinutes: 50.4 })]);
    expect(e.tasks[0].trackedMinutes).toBe(50);
    expect(e.tasks[0].ratio).toBe(1.68); // 50.4/30, not 50/30
  });

  it("sorts tasks by ratio descending — worst under-estimates first", () => {
    const e = buildEstimation([
      row({ taskId: 1, estimatedMinutes: 30, trackedMinutes: 30 }),
      row({ taskId: 2, estimatedMinutes: 10, trackedMinutes: 40 }),
      row({ taskId: 3, estimatedMinutes: 40, trackedMinutes: 20 }),
    ]);
    expect(e.tasks.map((t) => t.taskId)).toEqual([2, 1, 3]);
  });

  it("groups per-category totals with their own ratio, largest tracked first", () => {
    const e = buildEstimation([
      row({ categoryId: 1, categoryName: "Work", estimatedMinutes: 30, trackedMinutes: 45 }),
      row({ categoryId: 1, categoryName: "Work", estimatedMinutes: 10, trackedMinutes: 15 }),
      row({
        categoryId: 2,
        categoryName: "Study",
        categoryColor: "#a06bff",
        estimatedMinutes: 100,
        trackedMinutes: 80,
      }),
    ]);
    expect(e.byCategory).toEqual([
      {
        categoryId: 2,
        name: "Study",
        color: "#a06bff",
        estimatedMinutes: 100,
        trackedMinutes: 80,
        ratio: 0.8,
      },
      {
        categoryId: 1,
        name: "Work",
        color: "#4f8cff",
        estimatedMinutes: 40,
        trackedMinutes: 60,
        ratio: 1.5,
      },
    ]);
  });
});
