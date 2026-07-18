import { describe, expect, it } from "vitest";
import { formatResolvedDate, formatTrackedMinutes, targetDelta } from "./goalShelf";

// Instants built from LOCAL date components: the helpers truncate to the
// runner's local day, so a fixed UTC string would shift a calendar day in
// far-offset zones (a noon-UTC instant is already "tomorrow" in UTC+13).
// Deriving the instant from the local calendar keeps every expectation
// true in EVERY timezone the suite can run in.
const localNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

describe("formatResolvedDate", () => {
  it("renders the compact day-first form", () => {
    expect(formatResolvedDate(localNoon(2026, 7, 12))).toBe("12 Jul 2026");
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
    expect(targetDelta(null, localNoon(2026, 7, 12))).toBeNull();
    expect(targetDelta("2026-07-12", null)).toBeNull();
    expect(targetDelta(null, null)).toBeNull();
  });

  it("counts days before the target", () => {
    expect(targetDelta("2026-07-14", localNoon(2026, 7, 12))).toBe("2d before target");
  });

  it("counts days after the target", () => {
    expect(targetDelta("2026-07-01", localNoon(2026, 7, 12))).toBe("11d after target");
  });

  it("names a resolution on the target day itself", () => {
    expect(targetDelta("2026-07-12", localNoon(2026, 7, 12))).toBe("on target day");
  });
});
