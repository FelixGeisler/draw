import { describe, expect, it } from "vitest";
import {
  WEEK_CURSOR_CHARACTER_LIMIT,
  decodeWeekResponse,
  type WeekResponse,
} from "../../../shared/weekContract.js";
import { encodeWeekCursor } from "../../src/services/weekProjection.js";

const response: WeekResponse = {
  weekStart: "2026-10-26",
  timezone: "Europe/Berlin",
  requestNow: "2026-10-29T12:00:00.000Z",
  records: [
    {
      kind: "task", id: 42, title: "task", titleTruncated: false, status: "open",
      fixed: {
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-27T09:00:00.000Z",
        contextDate: "2026-10-27",
      },
      deadline: { date: "2026-10-30" },
    },
    {
      kind: "goal", id: 7, title: "goal", titleTruncated: false,
      status: "active", deadline: { date: "2026-10-31" },
    },
    {
      kind: "tracked", id: 9, taskId: 42, taskStatus: "done", title: "task",
      titleTruncated: false, startedAt: "2026-10-29T10:00:00.000Z",
      effectiveEndAt: "2026-10-29T11:00:00.000Z", running: false,
    },
  ],
  nextCursor: null,
};

function clone(): Record<string, unknown> {
  return structuredClone(response) as unknown as Record<string, unknown>;
}

describe("closed Week wire contract", () => {
  it("accepts the exact envelope and all record variants", () => {
    expect(decodeWeekResponse(response)).toEqual(response);
  });

  it("rejects missing, extra, wrongly typed and invariant-breaking values as a whole", () => {
    const invalid: unknown[] = [];
    const extraEnvelope = clone();
    extraEnvelope.extra = true;
    invalid.push(extraEnvelope);
    const missingEnvelope = clone();
    delete missingEnvelope.nextCursor;
    invalid.push(missingEnvelope);

    for (const mutate of [
      (value: any) => { value.records[0].extra = 1; },
      (value: any) => { delete value.records[0].fixed; },
      (value: any) => { value.records[0].fixed = null; value.records[0].deadline = null; },
      (value: any) => { value.records[0].id = 0; },
      (value: any) => { value.records[0].id = 9_007_199_254_740_992; },
      (value: any) => { value.records[0].status = "archived"; },
      (value: any) => { value.records[0].fixed.endsAt = value.records[0].fixed.startsAt; },
      (value: any) => { value.records[1].status = "done"; },
      (value: any) => { value.records[1].deadline.date = "2026-02-30"; },
      (value: any) => { value.records[2].taskId = null; },
      (value: any) => { value.records[2].running = "yes"; },
      (value: any) => { value.records[2].effectiveEndAt = value.records[2].startedAt; },
      (value: any) => { value.requestNow = "+010000-01-01T00:00:00.000Z"; },
      (value: any) => { value.timezone = "Europe/Busingen"; },
      (value: any) => { value.nextCursor = "A".repeat(332); },
    ]) {
      const value = clone();
      mutate(value);
      invalid.push(value);
    }
    for (const value of invalid) expect(() => decodeWeekResponse(value)).toThrow("invalid Week response");
  });

  it("derives the exact maximal 248-byte / 331-character cursor policy fixture", () => {
    const fixture = {
      v: 1 as const,
      w: "9999-12-27",
      z: "x".repeat(128),
      n: "9999-12-31T23:59:59.999Z",
      a: "9999-12-31T23:59:59.999Z",
      k: 2 as const,
      i: 9_007_199_254_740_991,
    };
    expect(Buffer.byteLength(JSON.stringify(fixture), "utf8")).toBe(248);
    expect(encodeWeekCursor(fixture)).toHaveLength(WEEK_CURSOR_CHARACTER_LIMIT);
    expect(encodeWeekCursor(fixture)).not.toContain("=");
  });
});
