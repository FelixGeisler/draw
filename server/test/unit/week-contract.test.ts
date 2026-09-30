import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeWeekResponse } from "../../../shared/weekContract.js";
import {
  WEEK_CURSOR_MAX_CHARS,
  WEEK_SEMANTIC_CURSOR_MAX_CHARS,
  createWeekCursorCodec,
} from "../../src/weekCursor.js";
import { contextDateForInstant, resolveWeek } from "../../src/weekTime.js";

function durationHours(weekStart: string, timezone: string): number {
  const week = resolveWeek(weekStart, timezone);
  expect(week).not.toBeNull();
  return (week!.rangeEndMs - week!.rangeStartMs) / 3_600_000;
}

describe("Week time and cursor contract", () => {
  it("resolves real Monday weeks as seven local dates rather than 168 hours", () => {
    expect(durationHours("2026-03-23", "Europe/Berlin")).toBe(167);
    expect(durationHours("2026-10-19", "Europe/Berlin")).toBe(169);
    expect(durationHours("2026-03-02", "America/New_York")).toBe(167);
    expect(durationHours("2026-10-26", "America/New_York")).toBe(169);
    expect(resolveWeek("2026-10-27", "UTC")).toBeNull();
    expect(resolveWeek("2026-10-26", "US/Eastern")).toBeNull();
    expect(resolveWeek("2026-10-26", " Europe/Berlin")).toBeNull();
  });

  it("enforces the four-digit lower and upper Week boundaries", () => {
    expect(resolveWeek("0001-01-01", "UTC")).not.toBeNull();
    expect(resolveWeek("0001-01-01", "America/New_York")).not.toBeNull();
    expect(resolveWeek("0001-01-01", "Europe/Berlin")).toBeNull();
    expect(resolveWeek("9999-12-20", "UTC")).not.toBeNull();
    expect(resolveWeek("9999-12-27", "UTC")).toBeNull();
    expect(contextDateForInstant("0001-01-01T00:00:00.000Z", "America/New_York")).toBeNull();
    expect(contextDateForInstant("9999-12-31T23:59:59.999Z", "Pacific/Kiritimati")).toBeNull();
  });

  it("round-trips the exact 244-character maximum semantic v2 cursor", () => {
    const week = resolveWeek("9999-12-20", "America/Argentina/Buenos_Aires")!;
    const codec = createWeekCursorCodec(Buffer.alloc(32, 7));
    const position = {
      requestNow: "9999-12-26T23:59:59.999Z",
      anchor: "9999-12-26T23:59:59.999Z",
      kindRank: 2 as const,
      id: Number.MAX_SAFE_INTEGER,
    };
    const cursor = codec.encode(week, position);
    expect(cursor).toHaveLength(WEEK_SEMANTIC_CURSOR_MAX_CHARS);
    expect(codec.decode(cursor, week)).toEqual(position);
  });

  it("authenticates a structural 375-character fixture before rejecting its zone", () => {
    const key = Buffer.alloc(32, 11);
    const codec = createWeekCursorCodec(key);
    const week = resolveWeek("9999-12-20", "UTC")!;
    const payload = Buffer.from(JSON.stringify({
      v: 2,
      w: "9999-12-20",
      z: `A/${"z".repeat(126)}`,
      n: "9999-12-26T23:59:59.999Z",
      a: "9999-12-26T23:59:59.999Z",
      k: 2,
      i: Number.MAX_SAFE_INTEGER,
    }));
    expect(payload).toHaveLength(248);
    const tag = crypto.createHmac("sha256", key).update(payload).digest("base64url");
    const cursor = `${payload.toString("base64url")}.${tag}`;
    expect(cursor).toHaveLength(WEEK_CURSOR_MAX_CHARS);
    expect(() => codec.decode(cursor, week)).toThrow("invalid Week cursor");
    expect(() => codec.decode(`${cursor}x`, week)).toThrow("invalid Week cursor");
    expect(() => codec.decode(cursor.replace(/.$/, "A"), week)).toThrow("invalid Week cursor");
  });
});

describe("shared closed Week response decoder", () => {
  const example = {
    weekStart: "2026-10-26",
    timezone: "Europe/Berlin",
    requestNow: "2026-10-29T12:00:00.000Z",
    records: [
      { kind: "task", id: 42, title: "Prepare review", titleTruncated: false, status: "open", fixed: { startsAt: "2026-10-27T08:00:00.000Z", endsAt: "2026-10-27T09:30:00.000Z", contextDate: "2026-10-27" }, deadline: { date: "2026-10-30" } },
      { kind: "goal", id: 7, title: "Submit portfolio", titleTruncated: false, status: "active", deadline: { date: "2026-10-31" } },
      { kind: "tracked", id: 901, taskId: 42, taskStatus: "open", title: "Prepare review", titleTruncated: false, startedAt: "2026-10-29T10:15:00.000Z", effectiveEndAt: "2026-10-29T12:00:00.000Z", running: true },
    ],
    nextCursor: null,
  };

  it("accepts the exact all-variant example and nullable fixed context", () => {
    expect(decodeWeekResponse(example)).toEqual(example);
    const boundary: unknown = structuredClone(example);
    (boundary as { records: Array<{ fixed: { contextDate: string | null } }> })
      .records[0].fixed.contextDate = null;
    expect(decodeWeekResponse(boundary).records[0]).toMatchObject({ fixed: { contextDate: null } });
  });

  it("rejects missing, additional, wrongly typed, and invariant-breaking fields", () => {
    expect(() => decodeWeekResponse({ ...example, extra: true })).toThrow();
    expect(() => decodeWeekResponse({ ...example, nextCursor: undefined })).toThrow();
    expect(() => decodeWeekResponse({ ...example, records: [{ ...example.records[0], id: 0 }] })).toThrow();
    expect(() => decodeWeekResponse({ ...example, records: [{ ...example.records[0], fixed: null, deadline: null }] })).toThrow();
    expect(() => decodeWeekResponse({ ...example, records: [{ ...example.records[0], status: "done" }] })).toThrow();
    expect(() => decodeWeekResponse({ ...example, records: [example.records[2], example.records[2]] })).toThrow();
  });
});
