import crypto from "node:crypto";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createWeekCursorCodec, WEEK_CURSOR_MAX_CHARS } from "../../src/weekCursor.js";
import { WeekProjectionService, type WeekWorkerFactory } from "../../src/weekService.js";
import { resolveWeek } from "../../src/weekTime.js";

const week = resolveWeek("2026-10-26", "Europe/Berlin")!;
const key = Buffer.alloc(32, 23);
const valid = {
  v: 2,
  w: week.weekStart,
  z: week.timezone,
  n: "2026-10-29T12:00:00.000Z",
  a: "2026-10-29T10:15:00.000Z",
  k: 2,
  i: 901,
};

function signed(bytes: Buffer, signingKey = key): string {
  return `${bytes.toString("base64url")}.${crypto.createHmac("sha256", signingKey).update(bytes).digest("base64url")}`;
}
function json(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }

describe("Week cursor adversarial matrix", () => {
  it("accepts only canonical alphabet, padding, trailing bits, segment counts, and decoded sizes", () => {
    const codec = createWeekCursorCodec(key);
    const cursor = signed(json(valid));
    expect(codec.decode(cursor, week)).toEqual({
      requestNow: valid.n, anchor: valid.a, kindRank: valid.k, id: valid.i,
    });
    for (const malformed of [
      `${cursor}=`, cursor.replace(".", ".."), `+${cursor.slice(1)}`,
      `${cursor.slice(0, cursor.indexOf("."))}A.${cursor.slice(cursor.indexOf(".") + 1)}`,
      `${"A".repeat(332)}.${"A".repeat(43)}`,
      `${"A".repeat(331)}.${"A".repeat(44)}`,
      "A.A", "é.A",
    ]) expect(() => codec.decode(malformed, week)).toThrow("invalid Week cursor");
    expect(WEEK_CURSOR_MAX_CHARS).toBe(375);
    expect(() => codec.decode("A".repeat(376), week)).toThrow("invalid Week cursor");
  });

  it("authenticates before rejecting malformed UTF-8/JSON and exact key order, types, ranges, and binding", () => {
    const codec = createWeekCursorCodec(key);
    const candidates: Buffer[] = [
      Buffer.from([0xff]),
      Buffer.from("{", "utf8"),
      json({ w: valid.w, v: 2, z: valid.z, n: valid.n, a: valid.a, k: 2, i: 901 }),
      json({ ...valid, extra: true }),
      json({ v: 2, w: valid.w, z: valid.z, n: valid.n, a: valid.a, k: 2 }),
      json({ ...valid, v: 1 }),
      json({ ...valid, w: "2026-11-02" }),
      json({ ...valid, z: "UTC" }),
      json({ ...valid, n: "2026-10-29T12:00:00Z" }),
      json({ ...valid, a: week.rangeEnd }),
      json({ ...valid, k: 3 }),
      json({ ...valid, i: 0 }),
      json({ ...valid, i: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const bytes of candidates) expect(() => codec.decode(signed(bytes), week)).toThrow("invalid Week cursor");

    const forged = signed(json(valid), Buffer.alloc(32, 24));
    expect(() => codec.decode(forged, week)).toThrow("invalid Week cursor");
    const tampered = signed(json(valid)).replace(/^[^.]/, "A");
    expect(() => codec.decode(tampered, week)).toThrow("invalid Week cursor");
  });

  it("invalidates on restart/commit, retains before commit, and rejects malformed cursors before worker creation", async () => {
    const original = createWeekCursorCodec(key);
    const cursor = original.encode(week, {
      requestNow: valid.n, anchor: valid.a, kindRank: 2, id: valid.i,
    });
    expect(() => createWeekCursorCodec(Buffer.alloc(32, 99)).decode(cursor, week)).toThrow();

    let workers = 0;
    const factory: WeekWorkerFactory = (() => {
      workers += 1;
      throw new Error("worker must not be created by cursor decoding");
    }) as unknown as WeekWorkerFactory;
    const service = new WeekProjectionService("fixture.db", undefined, factory);
    // Cursor rejection is a pure main-process operation: no worker/SQL admission.
    expect(() => service.decodeCursor("not-a-cursor", week)).toThrow();
    expect(workers).toBe(0);

    const retainedService = new WeekProjectionService("fixture.db", undefined,
      (() => { throw new Error("not expected"); }) as unknown as WeekWorkerFactory);
    // A malformed cursor remains a pure main-process operation across restore.
    await retainedService.beginRestore();
    retainedService.finishRestore(false, true);
    expect(() => retainedService.decodeCursor("not-a-cursor", week)).toThrow();
    await retainedService.beginRestore();
    retainedService.finishRestore(true, true);
    expect(workers).toBe(0);
  });
});
