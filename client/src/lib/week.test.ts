import { describe, expect, it } from "vitest";
import type { WeekRecord, WeekResponse } from "../../../shared/weekContract";
import {
  addWeekDays,
  appendWeekPage,
  createWeekContext,
  layoutWeekIntervals,
  mondayForInstant,
  resolveWeekMidnight,
  selectWeekTimezone,
} from "./week";

function pushStatus(timezone: unknown) {
  return {
    available: false,
    reason: "not-production",
    mutationAllowed: false,
    mutationReason: "secure-transport-required",
    vapidPublicKey: null,
    maxDevices: 16,
    preferences: {
      hideDetails: false,
      sendTime: "09:00",
      timezone,
      quietStart: null,
      quietEnd: null,
    },
    devices: [],
  };
}

function task(id: number, startsAt: string, endsAt: string): WeekRecord {
  return {
    kind: "task",
    id,
    title: `task ${id}`,
    titleTruncated: false,
    status: "open",
    fixed: { startsAt, endsAt, contextDate: startsAt.slice(0, 10) },
    deadline: null,
  };
}

function tracked(id: number, taskId: number, startsAt: string, effectiveEndAt: string): WeekRecord {
  return {
    kind: "tracked",
    id,
    taskId,
    taskStatus: "open",
    title: `tracked ${id}`,
    titleTruncated: false,
    startedAt: startsAt,
    effectiveEndAt,
    running: false,
  };
}

describe("Week timezone selection", () => {
  it("prefers the exact frozen saved zone", () => {
    expect(selectWeekTimezone(pushStatus("Europe/Berlin"), "America/New_York"))
      .toEqual({ ok: true, timezone: "Europe/Berlin", source: "saved" });
  });

  it.each([
    ["Push-valid alias", pushStatus("US/Eastern")],
    ["malformed saved status", { preferences: { timezone: "Europe/Berlin" } }],
    ["null saved zone", pushStatus(null)],
  ])("falls through from %s to exact canonical detection", (_label, status) => {
    expect(selectWeekTimezone(status, "Pacific/Chatham"))
      .toEqual({ ok: true, timezone: "Pacific/Chatham", source: "detected" });
  });

  it.each([" europe/berlin", "US/Eastern", "GMT+1", "Not/A_Zone", null])(
    "does not normalize or accept detected candidate %j",
    (detected) => expect(selectWeekTimezone(pushStatus(null), detected)).toEqual({ ok: false }),
  );
});

describe("Week local-calendar boundaries", () => {
  it.each([
    ["UTC", "2026-03-23", 168],
    ["Europe/Berlin", "2026-03-23", 167],
    ["America/New_York", "2026-10-26", 169],
    ["Australia/Lord_Howe", "2026-09-28", 167.5],
    ["Pacific/Chatham", "2026-06-29", 168],
  ])("resolves %s without a seven-times-24-hour assumption", (zone, week, hours) => {
    const context = createWeekContext(week, zone)!;
    expect((Date.parse(context.rangeEnd) - Date.parse(context.rangeStart)) / 3_600_000).toBe(hours);
    expect(context.dates).toHaveLength(7);
  });

  it("navigates by literal calendar days through year rollover", () => {
    expect(addWeekDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addWeekDays("2027-01-04", -7)).toBe("2026-12-28");
    expect(addWeekDays("9999-12-27", 7)).toBeNull();
  });

  it("finds Monday in the selected zone, not the host zone", () => {
    const instant = new Date("2026-01-04T23:30:00.000Z");
    expect(mondayForInstant(instant, "Europe/Berlin")).toBe("2026-01-05");
    expect(mondayForInstant(instant, "America/New_York")).toBe("2025-12-29");
  });

  it("resolves quarter-hour midnight and rejects non-Monday contexts", () => {
    expect(resolveWeekMidnight("2026-07-01", "Pacific/Chatham")).toBe("2026-06-30T11:15:00.000Z");
    expect(createWeekContext("2026-07-01", "Pacific/Chatham")).toBeNull();
  });

  it("keeps four-digit UTC bounds at the accepted lower/upper domain edges", () => {
    expect(createWeekContext("0001-01-01", "America/New_York")?.rangeStart)
      .toBe("0001-01-01T04:56:02.000Z");
    expect(createWeekContext("0001-01-01", "Europe/Berlin")).toBeNull();
    expect(createWeekContext("9999-12-20", "UTC")).not.toBeNull();
    expect(createWeekContext("9999-12-27", "UTC")).toBeNull();
  });
});

describe("Week interval layout", () => {
  const context = createWeekContext("2026-10-26", "UTC")!;

  it("clips both edges, splits overnight intervals, and keeps source records untouched", () => {
    const records = [
      task(1, "2026-10-25T23:00:00.000Z", "2026-10-26T01:00:00.000Z"),
      tracked(2, 1, "2026-10-27T23:30:00.000Z", "2026-10-28T01:30:00.000Z"),
      tracked(3, 1, "2026-11-01T23:00:00.000Z", "2026-11-02T02:00:00.000Z"),
    ];
    const before = JSON.stringify(records);
    const segments = layoutWeekIntervals(records, context);
    expect(segments.map((segment) => [segment.identity, segment.dayIndex])).toEqual([
      ["task:1", 0], ["tracked:2", 1], ["tracked:2", 2], ["tracked:3", 6],
    ]);
    expect(segments[0]).toMatchObject({ clippedStart: true, clippedEnd: false });
    expect(segments.at(-1)).toMatchObject({ clippedStart: false, clippedEnd: true });
    expect(JSON.stringify(records)).toBe(before);
  });

  it("assigns deterministic first-free lanes and lets adjacency share", () => {
    const records = [
      tracked(5, 1, "2026-10-27T09:00:00.000Z", "2026-10-27T11:00:00.000Z"),
      tracked(4, 1, "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z"),
      task(3, "2026-10-27T09:30:00.000Z", "2026-10-27T10:30:00.000Z"),
      task(6, "2026-10-27T11:00:00.000Z", "2026-10-27T12:00:00.000Z"),
    ];
    const first = layoutWeekIntervals(records, context);
    const second = layoutWeekIntervals([...records].reverse(), context);
    const shape = (rows: typeof first) => rows.map(({ identity, startsAt, lane, laneCount }) => ({ identity, startsAt, lane, laneCount }));
    expect(shape(second)).toEqual(shape(first));
    expect(first.find((row) => row.identity === "task:6")?.lane).toBe(0);
    expect(new Set(first.filter((row) => row.startsAt < "2026-10-27T10:00:00.000Z").map((row) => row.lane)).size).toBe(3);
  });
});

describe("Week continuation generations", () => {
  const context = createWeekContext("2026-10-26", "UTC")!;
  const page = (records: WeekRecord[], nextCursor: string | null = null): WeekResponse => ({
    weekStart: context.weekStart,
    timezone: context.timezone,
    requestNow: "2026-10-29T12:00:00.000Z",
    records,
    nextCursor,
  });

  it("appends a strictly ordered complete page", () => {
    const merged = appendWeekPage(
      page([task(1, "2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z")]),
      page([tracked(2, 1, "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z")]),
      context,
    );
    expect(merged.records.map((record) => `${record.kind}:${record.id}`)).toEqual(["task:1", "tracked:2"]);
  });

  it("rejects duplicate, reordered, and requestNow-mixed continuation pages", () => {
    const first = page([task(1, "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z")]);
    expect(() => appendWeekPage(first, page([task(1, "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z")]), context)).toThrow(/duplicated/);
    expect(() => appendWeekPage(first, page([tracked(2, 1, "2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z")]), context)).toThrow(/ordered/);
    expect(() => appendWeekPage(first, { ...page([]), requestNow: "2026-10-29T12:00:01.000Z" }, context)).toThrow(/generation/);
  });
});
