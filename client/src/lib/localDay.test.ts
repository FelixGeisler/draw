import { describe, expect, it } from "vitest";
import { addDays, asLocalDate, diffDays, localToday } from "./localDay";

// addDays/diffDays are pure string arithmetic (UTC trick), so those
// expectations are timezone-independent. localToday/asLocalDate depend on the
// runner's zone by design — asserted structurally, not against fixed values.

describe("addDays", () => {
  it("walks forward and backward across month and year boundaries", () => {
    expect(addDays("2026-07-15", 1)).toBe("2026-07-16");
    expect(addDays("2026-07-15", -15)).toBe("2026-06-30");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("crosses DST transitions without holes (date-only, UTC trick)", () => {
    // Europe/Berlin springs forward on 2026-03-29 — a local-time
    // implementation would skip or repeat a day here.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });
});

describe("diffDays", () => {
  it("is the inverse of addDays and signs by direction", () => {
    expect(diffDays("2026-07-15", addDays("2026-07-15", 42))).toBe(42);
    expect(diffDays("2026-07-15", "2026-07-01")).toBe(-14);
    expect(diffDays("2026-07-15", "2026-07-15")).toBe(0);
  });
});

describe("local-day parsing and formatting", () => {
  it("localToday returns a YYYY-MM-DD string", () => {
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("asLocalDate parses to local midnight (round-trips the calendar day)", () => {
    const d = asLocalDate("2026-07-15");
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 7, 15]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });
});
