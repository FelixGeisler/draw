import { describe, expect, it } from "vitest";
import {
  assertScheduleTimeZoneRuntime,
  isScheduleTimeZone,
  parseFixedSlotInput,
  resolveWallMinute,
} from "../../src/services/fixedSlots.js";
import { SCHEDULE_TZDB_RELEASE, SCHEDULE_TIME_ZONES } from "../../../shared/scheduleTimezones.js";
import {
  namedZoneBoundaryFailures,
  rejectedScheduleZones,
  validUtcBoundarySlots,
} from "../fixedSlotVectors.js";

function parse(startLocal: string, endLocal: string, entryTimezone: string) {
  return parseFixedSlotInput({ fixedSlot: { startLocal, endLocal, entryTimezone } });
}

describe("frozen schedule timezone registry", () => {
  it("is pinned to tzdb 2026b and fully supported by this Node/ICU build", () => {
    expect(SCHEDULE_TZDB_RELEASE).toBe("2026b");
    expect(SCHEDULE_TIME_ZONES).toContain("UTC");
    expect(SCHEDULE_TIME_ZONES).toContain("Europe/Berlin");
    expect(SCHEDULE_TIME_ZONES).toContain("America/New_York");
    expect(() => assertScheduleTimeZoneRuntime()).not.toThrow();
  });

  it.each(rejectedScheduleZones)("rejects non-canonical schedule identifier %s", (zone) => {
    expect(isScheduleTimeZone(zone)).toBe(false);
    expect(() => parse("2026-06-01T10:00", "2026-06-01T11:00", zone)).toThrow(
      /supported canonical schedule timezone/,
    );
  });
});

describe("strict wall-minute resolution", () => {
  it("chooses the earlier Berlin fold instant and returns exact offsets", () => {
    expect(parse("2026-10-25T02:30", "2026-10-25T03:30", "Europe/Berlin")).toEqual({
      present: true,
      value: {
        startLocal: "2026-10-25T02:30",
        endLocal: "2026-10-25T03:30",
        entryTimezone: "Europe/Berlin",
        startsAt: "2026-10-25T00:30:00.000Z",
        endsAt: "2026-10-25T02:30:00.000Z",
        startOffsetSeconds: 7200,
        endOffsetSeconds: 3600,
      },
    });
  });

  it("chooses the earlier New York fold instant", () => {
    expect(
      resolveWallMinute("2026-11-01T01:30", "America/New_York", "start").instant,
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects gaps, malformed dates, seconds, offsets, partial and extra keys", () => {
    expect(() => parse("2026-03-29T02:30", "2026-03-29T03:30", "Europe/Berlin")).toThrow(
      /nonexistent wall minute/,
    );
    for (const value of [
      "2026-02-30T10:00",
      "2026-6-01T10:00",
      "2026-06-01T10:00:00",
      "2026-06-01T10:00Z",
      "0000-01-01T00:00",
      "+010000-01-01T00:00",
    ]) {
      expect(() => parse(value, "2026-06-01T11:00", "UTC")).toThrow();
    }
    expect(() => parseFixedSlotInput({ fixedSlot: { startLocal: "2026-01-01T10:00" } })).toThrow(
      /exactly/,
    );
    expect(() =>
      parseFixedSlotInput({
        fixedSlot: {
          startLocal: "2026-01-01T10:00",
          endLocal: "2026-01-01T11:00",
          entryTimezone: "UTC",
          startsAt: "2026-01-01T10:00:00.000Z",
        },
      }),
    ).toThrow(/exactly/);
  });

  it("rejects non-positive resolved ranges but accepts cross-midnight", () => {
    expect(() => parse("2026-01-01T11:00", "2026-01-01T11:00", "UTC")).toThrow(
      /resolve after/,
    );
    expect(() => parse("2026-01-02T11:00", "2026-01-01T11:00", "UTC")).toThrow(
      /resolve after/,
    );
    expect(parse("2026-01-01T23:30", "2026-01-02T00:30", "UTC")).toMatchObject({
      value: {
        startsAt: "2026-01-01T23:30:00.000Z",
        endsAt: "2026-01-02T00:30:00.000Z",
      },
    });
  });

  it("checks UTC year bounds before serialization while shared valid UTC controls pass", () => {
    for (const vector of validUtcBoundarySlots) {
      expect(parse(vector.slot.startLocal, vector.slot.endLocal, vector.slot.entryTimezone)).toMatchObject({
        value: { startsAt: vector.startsAt, endsAt: vector.endsAt },
      });
    }
    for (const vector of namedZoneBoundaryFailures) {
      expect(() =>
        parse(vector.slot.startLocal, vector.slot.endLocal, vector.slot.entryTimezone),
      ).toThrow(/outside supported UTC years/);
    }
  });
});
