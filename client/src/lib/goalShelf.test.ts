import { describe, expect, it } from "vitest";
import { formatResolvedDate, formatTrackedMinutes, targetDelta } from "./goalShelf";

// Midday-UTC timestamps throughout: the helpers truncate to the LOCAL day,
// and noon UTC lands on the same calendar day in every offset this app can
// realistically run in (UTC-11 … UTC+11).

describe("formatResolvedDate", () => {
  it("renders the compact day-first form", () => {
    expect(formatResolvedDate("2026-07-12T12:00:00.000Z")).toBe("12 Jul 2026");
  });
});

describe("formatTrackedMinutes", () => {
  it("stays in minutes under an hour", () => {
    expect(formatTrackedMinutes(45)).toBe("~45 min");
    expect(formatTrackedMinutes(59.6)).toBe("~60 min");
  });

  it("switches to hours with one decimal while it matters", () => {
    expect(formatTrackedMinutes(60)).toBe("~1 h");
    expect(formatTrackedMinutes(90)).toBe("~1.5 h");
    expect(formatTrackedMinutes(590)).toBe("~9.8 h");
  });

  it("drops the decimal from 10 h up", () => {
    expect(formatTrackedMinutes(605)).toBe("~10 h");
    expect(formatTrackedMinutes(620)).toBe("~10 h");
  });
});

describe("targetDelta", () => {
  it("answers null without both dates — pre-v12 resolved rows have no resolvedAt", () => {
    expect(targetDelta(null, "2026-07-12T12:00:00.000Z")).toBeNull();
    expect(targetDelta("2026-07-12", null)).toBeNull();
    expect(targetDelta(null, null)).toBeNull();
  });

  it("counts days before the target", () => {
    expect(targetDelta("2026-07-14", "2026-07-12T12:00:00.000Z")).toBe("2d before target");
  });

  it("counts days after the target", () => {
    expect(targetDelta("2026-07-01", "2026-07-12T12:00:00.000Z")).toBe("11d after target");
  });

  it("names a resolution on the target day itself", () => {
    expect(targetDelta("2026-07-12", "2026-07-12T12:00:00.000Z")).toBe("on target day");
  });
});
