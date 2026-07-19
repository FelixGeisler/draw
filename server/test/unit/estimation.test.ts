import { describe, expect, it } from "vitest";
import {
  buildEstimation,
  trackedCyclesInRange,
  type EstimationInputRow,
} from "../../src/services/statsService.js";

let nextId = 1;
function row(overrides: Partial<EstimationInputRow> = {}): EstimationInputRow {
  const id = nextId++;
  return {
    taskId: id,
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
    expect(e.byCategory).toEqual([]);
    expect(e.summary).toEqual({
      taskCount: 0,
      totalEstimatedMinutes: 0,
      totalTrackedMinutes: 0,
      accuracyRatio: null,
      tendency: null,
    });
  });

  it("computes the accuracy ratio as tracked / estimated", () => {
    const e = buildEstimation([row({ estimatedMinutes: 30, trackedMinutes: 45 })]);
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

  it("excludes tasks with null or non-positive estimates from the totals", () => {
    const e = buildEstimation([
      row({ estimatedMinutes: null, trackedMinutes: 500 }),
      row({ estimatedMinutes: 0, trackedMinutes: 500 }),
      row({ estimatedMinutes: 20, trackedMinutes: 10 }),
    ]);
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

  it("rounds tracked minutes for display but derives the ratios from raw minutes", () => {
    const e = buildEstimation([row({ estimatedMinutes: 30, trackedMinutes: 50.4 })]);
    expect(e.summary.totalTrackedMinutes).toBe(50);
    expect(e.summary.accuracyRatio).toBe(1.68); // 50.4/30, not 50/30
    expect(e.byCategory[0]).toMatchObject({ trackedMinutes: 50, ratio: 1.68 });
  });

  it("reflects a single cycle for a recurring task with two completed cycles (#39)", () => {
    // Cycle 1: 30 min tracked, completed 04-30 (before range).
    // Cycle 2: 45 min tracked, completed 05-03 (in range). Estimate 30/cycle.
    const { minutes, cycles } = trackedCyclesInRange(
      ["2024-04-30T12:00:00.000Z", "2024-05-03T12:00:00.000Z"],
      [
        { startedAt: "2024-04-29T10:00:00.000Z", minutes: 30 },
        { startedAt: "2024-05-02T10:00:00.000Z", minutes: 45 },
      ],
      "2024-05-01",
      "2024-05-08",
    );
    const e = buildEstimation([row({ estimatedMinutes: 30 * cycles, trackedMinutes: minutes })]);
    // Lifetime attribution would report 75/30 = 2.5 — inflated by cycle 1.
    expect(e.summary.accuracyRatio).toBe(1.5);
  });

  it("scores N tracked in-range cycles against N per-cycle estimates (#48)", () => {
    // Two in-range completions, both cycles tracked. Estimate 30/cycle.
    const { minutes, cycles } = trackedCyclesInRange(
      ["2024-05-02T12:00:00.000Z", "2024-05-05T12:00:00.000Z"],
      [
        { startedAt: "2024-05-01T10:00:00.000Z", minutes: 20 },
        { startedAt: "2024-05-04T10:00:00.000Z", minutes: 70 },
      ],
      "2024-05-01",
      "2024-05-08",
    );
    const e = buildEstimation([row({ estimatedMinutes: 30 * cycles, trackedMinutes: minutes })]);
    // 90 tracked over 2 × 30 estimated — not 90 (or 70) over a single 30.
    expect(e.summary).toMatchObject({
      totalEstimatedMinutes: 60,
      totalTrackedMinutes: 90,
      accuracyRatio: 1.5,
    });
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
        taskCount: 1,
        estimatedMinutes: 100,
        trackedMinutes: 80,
        ratio: 0.8,
      },
      {
        categoryId: 1,
        name: "Work",
        color: "#4f8cff",
        taskCount: 2,
        estimatedMinutes: 40,
        trackedMinutes: 60,
        ratio: 1.5,
      },
    ]);
  });

  it("counts only qualifying tasks in a category's taskCount (#55)", () => {
    // The unestimated task shares the category but says nothing about
    // estimation accuracy — it must not inflate the coaching sample size.
    const e = buildEstimation([
      row({ categoryId: 1, estimatedMinutes: 30, trackedMinutes: 45 }),
      row({ categoryId: 1, estimatedMinutes: null, trackedMinutes: 120 }),
      row({ categoryId: 1, estimatedMinutes: 0, trackedMinutes: 60 }),
    ]);
    expect(e.byCategory).toHaveLength(1);
    expect(e.byCategory[0]).toMatchObject({ categoryId: 1, taskCount: 1, ratio: 1.5 });
  });
});

describe("trackedCyclesInRange", () => {
  const FROM = "2024-05-01";
  const TO = "2024-05-08"; // exclusive, like the SQL range filters
  const entry = (startedAt: string, minutes: number) => ({ startedAt, minutes });

  it("counts all entries up to completion when there is no previous completion", () => {
    // One-shot task: work started long before the range still counts.
    const tracked = trackedCyclesInRange(
      ["2024-05-03T12:00:00.000Z"],
      [entry("2024-04-20T10:00:00.000Z", 30), entry("2024-05-02T10:00:00.000Z", 15)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 45, cycles: 1 });
  });

  it("drops entries from before the previous completion", () => {
    const tracked = trackedCyclesInRange(
      ["2024-04-30T12:00:00.000Z", "2024-05-03T12:00:00.000Z"],
      [entry("2024-04-29T10:00:00.000Z", 60), entry("2024-05-02T10:00:00.000Z", 20)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 20, cycles: 1 });
  });

  it("drops entries started after the cycle's completion (next cycle underway)", () => {
    const tracked = trackedCyclesInRange(
      ["2024-05-03T12:00:00.000Z"],
      [entry("2024-05-02T10:00:00.000Z", 25), entry("2024-05-03T14:00:00.000Z", 40)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 25, cycles: 1 });
  });

  it("sums every tracked cycle when several completions fall in range (#48)", () => {
    const tracked = trackedCyclesInRange(
      ["2024-05-02T12:00:00.000Z", "2024-05-05T12:00:00.000Z"],
      [entry("2024-05-01T10:00:00.000Z", 20), entry("2024-05-04T10:00:00.000Z", 30)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 50, cycles: 2 });
  });

  it("keeps a task whose entries all belong to the EARLIER in-range cycle (#48)", () => {
    // Completed twice in range, timer only used before the first completion.
    // Latest-cycle-only attribution returned 0 here and the task vanished.
    const tracked = trackedCyclesInRange(
      ["2024-05-02T12:00:00.000Z", "2024-05-05T12:00:00.000Z"],
      [entry("2024-05-01T10:00:00.000Z", 20)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 20, cycles: 1 });
  });

  it("skips untracked cycles entirely — they must not scale the estimate", () => {
    // Three in-range completions, middle cycle checkbox-only: 2 cycles count.
    const tracked = trackedCyclesInRange(
      ["2024-05-02T12:00:00.000Z", "2024-05-04T12:00:00.000Z", "2024-05-06T12:00:00.000Z"],
      [entry("2024-05-01T10:00:00.000Z", 20), entry("2024-05-05T10:00:00.000Z", 40)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 60, cycles: 2 });
  });

  it("treats the boundaries as (previous completion, cycle completion]", () => {
    const prev = "2024-04-30T12:00:00.000Z";
    const end = "2024-05-03T12:00:00.000Z";
    const tracked = trackedCyclesInRange(
      [prev, end],
      // Started exactly at the previous completion: previous cycle's edge, out.
      // Started exactly at this cycle's completion: still this cycle, in.
      [entry(prev, 99), entry(end, 5)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 5, cycles: 1 });
  });

  it("does not order-depend on the completions array", () => {
    const tracked = trackedCyclesInRange(
      ["2024-05-03T12:00:00.000Z", "2024-04-30T12:00:00.000Z", "2024-04-27T12:00:00.000Z"],
      [entry("2024-04-28T10:00:00.000Z", 60), entry("2024-05-01T10:00:00.000Z", 10)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 10, cycles: 1 });
  });

  it("returns zero cycles when no completion falls in range", () => {
    const tracked = trackedCyclesInRange(
      ["2024-06-01T12:00:00.000Z"],
      [entry("2024-05-02T10:00:00.000Z", 30)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 0, cycles: 0 });
  });

  it("returns zero cycles when the only in-range cycle has no entries", () => {
    // Cycle 1 tracked but out of range, cycle 2 in range but checkbox-only.
    const tracked = trackedCyclesInRange(
      ["2024-04-30T12:00:00.000Z", "2024-05-03T12:00:00.000Z"],
      [entry("2024-04-29T10:00:00.000Z", 30)],
      FROM,
      TO,
    );
    expect(tracked).toEqual({ minutes: 0, cycles: 0 });
  });

  describe('all-history bounds ("" to 9999-12-31) as used by the bias endpoint (#55)', () => {
    it("attributes every tracked cycle regardless of year, still per-cycle", () => {
      // Same lexicographic comparisons as the SQL filters: "" sorts before
      // every ISO timestamp, year 9999 after every plausible one.
      const tracked = trackedCyclesInRange(
        ["2020-01-05T12:00:00.000Z", "2024-05-03T12:00:00.000Z"],
        [
          entry("2020-01-04T10:00:00.000Z", 45), // cycle 1, years back
          entry("2024-05-02T10:00:00.000Z", 25), // cycle 2
          entry("2024-05-03T14:00:00.000Z", 99), // after the last completion: next cycle, out
        ],
        "",
        "9999-12-31",
      );
      expect(tracked).toEqual({ minutes: 70, cycles: 2 });
    });

    it("still skips checkbox-only cycles over all history", () => {
      const tracked = trackedCyclesInRange(
        ["2023-03-01T12:00:00.000Z", "2023-06-01T12:00:00.000Z"],
        [entry("2023-02-27T10:00:00.000Z", 30)],
        "",
        "9999-12-31",
      );
      expect(tracked).toEqual({ minutes: 30, cycles: 1 });
    });
  });
});
