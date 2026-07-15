import { describe, expect, it } from "vitest";
import {
  HEATMAP_WEEKS,
  LEVEL_THRESHOLDS,
  activityLevel,
  heatmapRange,
  heatmapWeeks,
  minutesLevel,
  mondayIndex,
  mondayOf,
  monthLabels,
} from "./heatmap";

// All inputs/outputs are YYYY-MM-DD strings and the module does pure string
// arithmetic (UTC trick), so every expectation here is timezone-independent.

describe("minutesLevel quantization", () => {
  it("reserves level 0 for exactly zero minutes", () => {
    expect(minutesLevel(0)).toBe(0);
  });

  it("gives any non-zero activity at least level 1 — a 1-minute dab is not an empty day", () => {
    expect(minutesLevel(1)).toBe(1);
  });

  it("is deterministic at every bucket boundary", () => {
    // [0] | 1..14 | 15..44 | 45..119 | 120..∞ — pinned so a threshold change
    // is a deliberate, test-visible decision.
    expect(LEVEL_THRESHOLDS).toEqual([15, 45, 120]);
    expect(minutesLevel(14)).toBe(1);
    expect(minutesLevel(15)).toBe(2);
    expect(minutesLevel(44)).toBe(2);
    expect(minutesLevel(45)).toBe(3);
    expect(minutesLevel(119)).toBe(3);
    expect(minutesLevel(120)).toBe(4);
  });

  it("caps at level 4 for marathon days", () => {
    expect(minutesLevel(600)).toBe(4);
  });
});

describe("activityLevel — the level the heatmap actually shades by", () => {
  it("a timer-less completion is not an empty day (server rounds its minutes to 0)", () => {
    // Plain PATCH status done, no timer that day — ADR-21's union clause
    // gives it an upright skyline card; the heatmap must agree (PR #72).
    expect(activityLevel({ minutes: 0, started: 1 })).toBe(1);
  });

  it("a sub-30-second dab (minutes rounded to 0) still earns level 1", () => {
    expect(activityLevel({ minutes: 0, started: 1 })).toBe(1);
    expect(activityLevel({ minutes: 1, started: 1 })).toBe(1);
  });

  it("reserves level 0 for days with no cards laid at all", () => {
    expect(activityLevel({ minutes: 0, started: 0 })).toBe(0);
  });

  it("defers to the minutes quantization whenever minutes are non-zero", () => {
    expect(activityLevel({ minutes: 14, started: 3 })).toBe(1);
    expect(activityLevel({ minutes: 15, started: 1 })).toBe(2);
    expect(activityLevel({ minutes: 45, started: 1 })).toBe(3);
    expect(activityLevel({ minutes: 120, started: 5 })).toBe(4);
  });
});

describe("Monday-first weekday math", () => {
  it("indexes Monday 0 through Sunday 6 (TaskForm chip order)", () => {
    // 2026-07-13 is a Monday.
    const week = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"];
    expect(week.map(mondayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("mondayOf returns the same day for a Monday and walks back otherwise", () => {
    expect(mondayOf("2026-07-13")).toBe("2026-07-13");
    expect(mondayOf("2026-07-15")).toBe("2026-07-13");
    expect(mondayOf("2026-07-19")).toBe("2026-07-13"); // Sunday belongs to the week begun the 13th
  });

  it("crosses month and year boundaries", () => {
    // 2026-01-01 is a Thursday — its week began Monday 2025-12-29.
    expect(mondayOf("2026-01-01")).toBe("2025-12-29");
  });
});

describe("heatmapRange", () => {
  it("spans 26 week columns ending in today's (partial) week, from a Monday", () => {
    const { from, to } = heatmapRange("2026-07-15"); // a Wednesday
    expect(to).toBe("2026-07-15");
    expect(from).toBe("2026-01-19"); // Monday, 25 full weeks before Mon 2026-07-13
    expect(mondayIndex(from)).toBe(0);
    expect(heatmapWeeks(from, to)).toHaveLength(HEATMAP_WEEKS);
  });

  it("a Sunday today still yields the same Monday start as the rest of its week", () => {
    expect(heatmapRange("2026-07-19").from).toBe(heatmapRange("2026-07-13").from);
  });
});

describe("heatmapWeeks grid layout", () => {
  it("lays a Monday-to-Sunday range as one full column, straddling the year end", () => {
    const weeks = heatmapWeeks("2025-12-29", "2026-01-04");
    expect(weeks).toEqual([
      ["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"],
    ]);
  });

  it("pads the current partial week with trailing nulls, never future dates", () => {
    const weeks = heatmapWeeks("2026-07-13", "2026-07-15");
    expect(weeks).toEqual([["2026-07-13", "2026-07-14", "2026-07-15", null, null, null, null]]);
  });

  it("pads a mid-week `from` with leading nulls so weekday rows stay aligned", () => {
    const weeks = heatmapWeeks("2026-07-15", "2026-07-19");
    expect(weeks).toEqual([[null, null, "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]]);
  });

  it("every column has exactly 7 rows and consecutive columns are 7 days apart", () => {
    const { from, to } = heatmapRange("2026-03-08"); // Sunday, range crosses year end
    const weeks = heatmapWeeks(from, to);
    expect(weeks).toHaveLength(HEATMAP_WEEKS);
    for (const week of weeks) expect(week).toHaveLength(7);
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i][0]).not.toBeNull();
      expect(mondayIndex(weeks[i][0]!)).toBe(0);
    }
  });

  it("returns an empty grid for an inverted range", () => {
    expect(heatmapWeeks("2026-07-15", "2026-07-14")).toEqual([]);
  });
});

describe("monthLabels", () => {
  it("labels the first column whose week starts in a new month", () => {
    // Mondays 2026-06-01 … 2026-07-06: July's first Monday-started week is
    // column 5 (June 29's week contains July 1 but still starts in June).
    const weeks = heatmapWeeks("2026-06-01", "2026-07-12");
    expect(monthLabels(weeks)).toEqual(["2026-06", null, null, null, null, "2026-07"]);
  });

  it("suppresses the column-0 label when the next label is closer than 3 columns (collision rule)", () => {
    // Mon 2026-06-29 (June), Mon 2026-07-06 (July) — adjacent labels would collide.
    expect(monthLabels(heatmapWeeks("2026-06-29", "2026-07-12"))).toEqual([null, "2026-07"]);
    // Two columns away still collides with a wide "Jan 2026"-style label.
    expect(monthLabels(heatmapWeeks("2026-06-22", "2026-07-15"))).toEqual([
      null,
      null,
      "2026-07",
      null,
    ]);
  });

  it("labels a lone column with its own month", () => {
    const weeks = heatmapWeeks("2026-07-13", "2026-07-15");
    expect(monthLabels(weeks)).toEqual(["2026-07"]);
  });

  it("labels year-end and new-year months across the boundary", () => {
    // Mondays 2025-12-08 … 2026-01-05; Dec 29's week contains Jan 1 but
    // still starts in December, so January's label sits on Jan 5's column.
    const weeks = heatmapWeeks("2025-12-08", "2026-01-11");
    expect(monthLabels(weeks)).toEqual(["2025-12", null, null, null, "2026-01"]);
  });

  it("returns no labels for an empty grid", () => {
    expect(monthLabels([])).toEqual([]);
  });
});
