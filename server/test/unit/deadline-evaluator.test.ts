import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  createZonedFormatter,
  inQuietHours,
  occurrenceEligible,
  scheduledDateTime,
  validCalendarDate,
  validTimeZone,
  zonedMinute,
  type DeadlineTiming,
} from "../../src/push/deadlineEvaluator.js";

const timing = (overrides: Partial<DeadlineTiming> = {}): DeadlineTiming => ({
  leadDays: 1, sendTime: "09:00", timezone: "UTC", quietStart: null, quietEnd: null, ...overrides,
});

describe("deadline wall-calendar evaluator", () => {
  it("validates real year-0001..9999 dates and adds without year-zero/clamping", () => {
    expect(validCalendarDate("0001-01-01")).toBe(true);
    expect(validCalendarDate("9999-12-31")).toBe(true);
    expect(validCalendarDate("2000-02-29")).toBe(true);
    for (const value of ["0000-01-01", "10000-01-01", "1900-02-29", "2026-02-30", "+2026-01-01"]) {
      expect(validCalendarDate(value), value).toBe(false);
    }
    expect(addCalendarDays("0001-01-01", -1)).toBeNull();
    expect(addCalendarDays("9999-12-31", 1)).toBeNull();
    expect(addCalendarDays("0004-03-01", -1)).toBe("0004-02-29");
    expect(addCalendarDays("0100-03-01", -1)).toBe("0100-02-28");
  });

  it("covers every approved lead, due-day zero, and lexical boundaries", () => {
    for (const leadDays of [0, 1, 2, 3, 7, 14, 30]) {
      const value = timing({ leadDays });
      const scheduled = scheduledDateTime("2026-10-31", value)!;
      const [date, time] = scheduled.split("T");
      expect(occurrenceEligible("2026-10-31", value, { date, time, dateTime: scheduled })).toBe(true);
      expect(occurrenceEligible("2026-10-31", value, { date, time: "00:00", dateTime: `${date}T00:00` }))
        .toBe(time === "00:00");
    }
    expect(scheduledDateTime("2026-10-31", timing({ leadDays: 0 }))).toBe("2026-10-31T09:00");
  });

  it("canonicalizes native-Intl lower years for lexical eligibility", () => {
    const zone = createZonedFormatter("UTC");
    for (const [instant, expected] of [
      ["0001-01-01T09:00:00.000Z", "0001-01-01T09:00"],
      ["0099-12-31T09:00:00.000Z", "0099-12-31T09:00"],
      ["0999-06-15T09:00:00.000Z", "0999-06-15T09:00"],
    ] as const) {
      const now = zonedMinute(zone, new Date(instant));
      expect(now.dateTime).toBe(expected);
      expect(occurrenceEligible(now.date, timing({ leadDays: 0 }), now)).toBe(true);
    }
  });

  it("uses the first real wall minute after a spring gap and the first fold occurrence", () => {
    const zone = createZonedFormatter("America/New_York");
    const gapTiming = timing({ timezone: "America/New_York", leadDays: 0, sendTime: "02:15" });
    const beforeGap = zonedMinute(zone, new Date("2026-03-08T06:59:00Z"));
    const afterGap = zonedMinute(zone, new Date("2026-03-08T07:00:00Z"));
    expect(beforeGap.dateTime).toBe("2026-03-08T01:59");
    expect(afterGap.dateTime).toBe("2026-03-08T03:00");
    expect(occurrenceEligible("2026-03-08", gapTiming, beforeGap)).toBe(false);
    expect(occurrenceEligible("2026-03-08", gapTiming, afterGap)).toBe(true);

    const foldTiming = timing({ timezone: "America/New_York", leadDays: 0, sendTime: "01:30" });
    const first = zonedMinute(zone, new Date("2026-11-01T05:30:00Z"));
    const second = zonedMinute(zone, new Date("2026-11-01T06:30:00Z"));
    expect(first.dateTime).toBe("2026-11-01T01:30");
    expect(second.dateTime).toBe("2026-11-01T01:30");
    expect(occurrenceEligible("2026-11-01", foldTiming, first)).toBe(true);
    expect(occurrenceEligible("2026-11-01", foldTiming, second)).toBe(true);
  });

  it("implements half-open quiet boundaries, crossing midnight, catch-up, and overdue suppression", () => {
    expect(inQuietHours("09:00", "09:00", "10:00")).toBe(true);
    expect(inQuietHours("10:00", "09:00", "10:00")).toBe(false);
    expect(inQuietHours("23:59", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("00:00", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("08:00", "22:00", "08:00")).toBe(false);
    const value = timing({ quietStart: "08:00", quietEnd: "10:00" });
    expect(occurrenceEligible("2026-09-21", value, { date: "2026-09-20", time: "09:30", dateTime: "2026-09-20T09:30" })).toBe(false);
    expect(occurrenceEligible("2026-09-21", value, { date: "2026-09-20", time: "10:00", dateTime: "2026-09-20T10:00" })).toBe(true);
    expect(occurrenceEligible("2026-09-21", value, { date: "2026-09-22", time: "10:00", dateTime: "2026-09-22T10:00" })).toBe(false);
  });

  it("validates exact ASCII native-Intl zones without trimming", () => {
    expect(validTimeZone("UTC")).toBe(true);
    expect(validTimeZone("Europe/Berlin")).toBe(true);
    expect(validTimeZone(" UTC")).toBe(false);
    expect(validTimeZone("No/Such_Zone")).toBe(false);
    expect(validTimeZone("ÜTC")).toBe(false);
  });
});
