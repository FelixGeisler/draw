import request from "supertest";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type express from "express";
import { createApp } from "../../src/app.js";
import { db } from "../../src/db.js";
import { projectWeek, resolveWeek } from "../../src/services/weekProjection.js";
import { WEEK_JSON_BYTE_LIMIT } from "../../../shared/weekContract.js";

const MONDAY = "2026-10-26";
const ZONE = "Europe/Berlin";
const NOW = new Date("2026-10-29T12:00:00.000Z");
let app: express.Express;
let categoryId: number;

function addTask(title: string, options: { id?: number; status?: string; due?: string } = {}): number {
  const info = db.prepare(
    `INSERT INTO tasks (id,title,category_id,status,due_date,created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(options.id ?? null, title, categoryId, options.status ?? "open", options.due ?? null, "2026-01-01T00:00:00.000Z");
  return Number(options.id ?? info.lastInsertRowid);
}

function addGoal(title: string, date = "2026-10-31", id?: number): number {
  const info = db.prepare(
    "INSERT INTO goals (id,title,target_date,status,created_at) VALUES (?,?,?,'active',?)",
  ).run(id ?? null, title, date, "2026-01-01T00:00:00.000Z");
  return Number(id ?? info.lastInsertRowid);
}

function url(cursor?: string): string {
  const params = new URLSearchParams({ weekStart: MONDAY, timezone: ZONE });
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/api/calendar/week?${params}`;
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  app = createApp();
  categoryId = (db.prepare("SELECT id FROM categories ORDER BY id LIMIT 1").get() as { id: number }).id;
});

beforeEach(() => {
  db.exec("DELETE FROM time_entries; DELETE FROM task_fixed_slots; DELETE FROM tasks; DELETE FROM goals;");
});

afterAll(() => vi.useRealTimers());

describe("GET /api/calendar/week", () => {
  it("returns the exact all-variant union, one dual-facet identity and separate running work without writes", async () => {
    const taskId = addTask("Prepare review", { due: "2026-10-30" });
    db.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
      .run(taskId, "2026-10-27T08:00:00.000Z", "2026-10-27T09:30:00.000Z", ZONE);
    const goalId = addGoal("Submit portfolio");
    const trackedId = Number(db.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,NULL)",
    ).run(taskId, "2026-10-29T10:15:00.000Z").lastInsertRowid);
    const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };

    const response = await request(app).get(url()).expect(200).expect("Content-Type", /json/);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      weekStart: MONDAY,
      timezone: ZONE,
      requestNow: NOW.toISOString(),
      records: [
        {
          kind: "task", id: taskId, title: "Prepare review", titleTruncated: false, status: "open",
          fixed: {
            startsAt: "2026-10-27T08:00:00.000Z",
            endsAt: "2026-10-27T09:30:00.000Z",
            contextDate: "2026-10-27",
          },
          deadline: { date: "2026-10-30" },
        },
        {
          kind: "tracked", id: trackedId, taskId, taskStatus: "open", title: "Prepare review",
          titleTruncated: false, startedAt: "2026-10-29T10:15:00.000Z",
          effectiveEndAt: NOW.toISOString(), running: true,
        },
        {
          kind: "goal", id: goalId, title: "Submit portfolio", titleTruncated: false,
          status: "active", deadline: { date: "2026-10-31" },
        },
      ],
      nextCursor: null,
    });
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.prepare("SELECT ended_at AS endedAt FROM time_entries WHERE id=?").get(trackedId)).toEqual({ endedAt: null });
  });

  it("enforces the closed query, Monday, frozen zone and four-digit zoned bounds", async () => {
    const invalid = [
      "/api/calendar/week",
      `/api/calendar/week?weekStart=${MONDAY}`,
      `/api/calendar/week?weekStart=${MONDAY}&timezone=UTC&extra=1`,
      `/api/calendar/week?weekStart=${MONDAY}&weekStart=${MONDAY}&timezone=UTC`,
      "/api/calendar/week?weekStart=2026-10-27&timezone=UTC",
      `/api/calendar/week?weekStart=${MONDAY}&timezone=utc`,
      `/api/calendar/week?weekStart=${MONDAY}&timezone=Europe%2FBerlin%20`,
      `/api/calendar/week?weekStart=${MONDAY}&timezone=Europe%2FBusingen`,
      `/api/calendar/week?weekStart=${MONDAY}&timezone=Etc%2FGMT%2B1`,
      "/api/calendar/week?weekStart=0001-01-01&timezone=Europe%2FBerlin",
      "/api/calendar/week?weekStart=9999-12-27&timezone=UTC",
    ];
    for (const path of invalid) {
      const response = await request(app).get(path).expect(400).expect("Content-Type", /json/);
      expect(response.body).toEqual({ error: "invalid-week-request" });
    }
    await request(app).get("/api/calendar/week?weekStart=0001-01-01&timezone=UTC").expect(200);
    await request(app).get("/api/calendar/week?weekStart=9999-12-20&timezone=UTC").expect(200);
  });

  it("resolves ordinary rollover and 167/169-hour Berlin and New York Weeks", () => {
    const hours = (start: string, timezone: string) => {
      const week = resolveWeek(start, timezone);
      return (Date.parse(week.rangeEnd) - Date.parse(week.rangeStart)) / 3_600_000;
    };
    expect(resolveWeek("2026-12-28", "UTC").dates).toEqual([
      "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31",
      "2027-01-01", "2027-01-02", "2027-01-03",
    ]);
    expect(hours("2026-03-23", "Europe/Berlin")).toBe(167);
    expect(hours("2026-10-19", "Europe/Berlin")).toBe(169);
    expect(hours("2026-03-02", "America/New_York")).toBe(167);
    expect(hours("2026-10-26", "America/New_York")).toBe(169);
  });

  it.each([99, 100, 101])("bounds %i candidates with title-free 101 look-ahead and complete keyset paging", async (count) => {
    const insert = db.prepare("INSERT INTO goals(title,target_date,status,created_at) VALUES (?,?,'active',?)");
    db.transaction(() => {
      for (let id = 1; id <= count; id++) insert.run(`Goal ${String(id).padStart(3, "0")}`, "2026-10-30", "2026-01-01T00:00:00.000Z");
    })();
    const identityCounts: number[] = [];
    const titleReads: number[] = [];
    const first = projectWeek(
      { weekStart: MONDAY, timezone: ZONE },
      db,
      {
        now: () => NOW,
        instrumentation: {
          identityCount: (value) => identityCounts.push(value),
          titleRead: (bytes) => titleReads.push(bytes),
        },
      },
    );
    expect(first.records).toHaveLength(Math.min(count, 100));
    expect(identityCounts).toEqual([Math.min(count, 101)]);
    expect(titleReads).toHaveLength(Math.min(count, 100));
    expect(new Set(titleReads)).toEqual(new Set([WEEK_JSON_BYTE_LIMIT + 4]));
    if (count <= 100) {
      expect(first.nextCursor).toBeNull();
    } else {
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.nextCursor!.length).toBeLessThanOrEqual(331);
      const second = projectWeek({ weekStart: MONDAY, timezone: ZONE, cursor: first.nextCursor! }, db);
      expect(second.requestNow).toBe(first.requestNow);
      expect(second.records).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.records, ...second.records].map((record) => record.id)).toEqual(
        Array.from({ length: 101 }, (_, index) => index + 1),
      );
    }
  });

  it("rejects noncanonical, malformed, widened and mismatched cursors before projection", async () => {
    for (let id = 1; id <= 101; id++) addGoal(`g${id}`, "2026-10-30");
    const first = await request(app).get(url()).expect(200);
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const badJson = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const cases = [
      cursor + "=",
      "A".repeat(332),
      "not%base64",
      Buffer.from([0xff]).toString("base64url"),
      Buffer.from("not json").toString("base64url"),
      badJson({ w: parsed.w, v: 1, z: parsed.z, n: parsed.n, a: parsed.a, k: parsed.k, i: parsed.i }),
      badJson({ ...parsed, extra: 1 }),
      badJson({ ...parsed, v: 2 }),
      badJson({ ...parsed, w: "2026-11-02" }),
      badJson({ ...parsed, z: "UTC" }),
      badJson({ ...parsed, n: "+010000-01-01T00:00:00.000Z" }),
      badJson({ ...parsed, a: "2026-11-02T00:00:00.000Z" }),
      badJson({ ...parsed, k: 3 }),
      badJson({ ...parsed, i: 9_007_199_254_740_992 }),
    ];
    for (const bad of cases) {
      expect((await request(app).get(url(bad))).body).toEqual({ error: "invalid-week-request" });
    }
  });

  it("excludes malformed restored facts lazily while retaining an independent valid deadline", () => {
    const taskId = addTask("guarded", { due: "2026-10-30" });
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
        .run(taskId, "+010000-01-01T00:00:00.000Z".repeat(20_000), "2026-10-30T10:00:00.000Z", ZONE);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
    const insert = db.prepare("INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)");
    const malformed = [
      ["0000-10-29T10:00:00.000Z", "2026-10-29T11:00:00.000Z"],
      ["+010000-01-01T00:00:00.000Z", null],
      ["2026-10-29T10:00:00.00Z", null],
      ["2026-10-29T10:00:00+00:00", null],
      ["-0001-10-29T10:00:00.000Z", null],
      ["026-10-29T10:00:00.000Z", null],
      ["2026-02-30T10:00:00.000Z", null],
      ["2026-10-29T10:00:00.000Z", "2026-10-29T09:00:00.000Z"],
      ["2026-10-30T10:00:00.000Z", null],
      ["x".repeat(200_000), null],
    ] as const;
    for (const row of malformed) insert.run(taskId, row[0], row[1]);
    insert.run(taskId, "2026-10-29T10:00:00.000Z", "2026-10-29T11:00:00.000Z");
    db.exec(`
      INSERT INTO time_entries(id,task_id,started_at,ended_at)
      VALUES (9007199254740992,${taskId},'2026-10-29T08:00:00.000Z','2026-10-29T09:00:00.000Z');
      INSERT INTO goals(id,title,target_date,status,created_at)
      VALUES (9007199254740992,'unsafe goal','2026-10-30','active','2026-01-01T00:00:00.000Z');
      INSERT INTO tasks(id,title,category_id,status,due_date,created_at)
      VALUES (9007199254740992,'unsafe task',${categoryId},'open','2026-10-30','2026-01-01T00:00:00.000Z');
    `);
    const parsed: string[] = [];
    const result = projectWeek(
      { weekStart: MONDAY, timezone: ZONE }, db,
      { now: () => NOW, instrumentation: { canonicalParse: (value) => parsed.push(value) } },
    );
    expect(result.records.filter((record) => record.kind === "task")).toEqual([
      expect.objectContaining({ fixed: null, deadline: { date: "2026-10-30" } }),
    ]);
    expect(result.records.filter((record) => record.kind === "tracked")).toHaveLength(1);
    expect(parsed.every((value) => Buffer.byteLength(value, "utf8") === 24)).toBe(true);
    expect(parsed).not.toContain(expect.stringContaining("+010000"));
    expect(parsed).not.toContain("x".repeat(200_000));
  });

  it("applies facet state, clipped-anchor and exact interval-overlap rules without merging sessions", () => {
    const crossing = addTask("crossing done", { status: "done", due: "2026-10-30" });
    db.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
      .run(crossing, "2026-10-25T22:30:00.000Z", "2026-10-26T01:00:00.000Z", "UTC");
    const archived = addTask("archived", { status: "archived", due: "2026-10-30" });
    db.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
      .run(archived, "2026-10-27T08:00:00.000Z", "2026-10-27T09:00:00.000Z", "UTC");
    const sameDay = addTask("fixed primary", { due: "2026-10-28" });
    db.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)")
      .run(sameDay, "2026-10-28T12:00:00.000Z", "2026-10-28T13:00:00.000Z", "UTC");
    const midnightGoal = addGoal("midnight first", "2026-10-28");

    const insert = db.prepare("INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)");
    const adjacencyBefore = Number(insert.run(archived, "2026-10-25T20:00:00.000Z", "2026-10-25T23:00:00.000Z").lastInsertRowid);
    const crossingSession = Number(insert.run(archived, "2026-10-25T22:00:00.000Z", "2026-10-26T01:00:00.000Z").lastInsertRowid);
    const equalOne = Number(insert.run(archived, "2026-10-29T09:00:00.000Z", "2026-10-29T12:00:00.000Z").lastInsertRowid);
    const equalTwo = Number(insert.run(archived, "2026-10-29T09:00:00.000Z", "2026-10-29T10:00:00.000Z").lastInsertRowid);
    insert.run(archived, "2026-11-02T00:00:00.000Z", "2026-11-02T01:00:00.000Z"); // adjacency at end

    const result = projectWeek({ weekStart: MONDAY, timezone: "UTC" }, db, { now: () => NOW });
    const planningIds = result.records.filter((record) => record.kind !== "tracked").map((record) => record.id);
    expect(planningIds).toContain(crossing);
    expect(planningIds).not.toContain(archived);
    expect(result.records.find((record) => record.kind === "task" && record.id === crossing)).toMatchObject({
      status: "done", deadline: null,
      fixed: { contextDate: "2026-10-25", startsAt: "2026-10-25T22:30:00.000Z" },
    });
    expect(result.records.findIndex((record) => record.kind === "goal" && record.id === midnightGoal))
      .toBeLessThan(result.records.findIndex((record) => record.kind === "task" && record.id === sameDay));
    const tracked = result.records.filter((record) => record.kind === "tracked");
    expect(tracked.map((record) => record.id)).toEqual([crossingSession, equalOne, equalTwo]);
    expect(tracked.every((record) => record.taskStatus === "archived" && record.taskId === archived)).toBe(true);
    expect(tracked.map((record) => record.id)).not.toContain(adjacencyBefore);
  });

  it("keeps intact records intact across pages and truncates only an oversized record on code-point boundaries", () => {
    const firstId = addGoal("a".repeat(90_000), "2026-10-27");
    const secondTitle = `quote\" control\n combining e\u0301 emoji ${"😀".repeat(40_000)}`;
    const secondId = addGoal(secondTitle, "2026-10-28");
    const first = projectWeek({ weekStart: MONDAY, timezone: ZONE }, db, { now: () => NOW });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ id: firstId, titleTruncated: false, title: "a".repeat(90_000) });
    expect(first.nextCursor).not.toBeNull();
    const second = projectWeek({ weekStart: MONDAY, timezone: ZONE, cursor: first.nextCursor! }, db);
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ id: secondId, titleTruncated: true });
    expect((second.records[0] as { title: string }).title).not.toContain("�");
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(WEEK_JSON_BYTE_LIMIT);
    expect(db.prepare("SELECT CAST(title AS BLOB) AS title FROM goals WHERE id=?").get(secondId)).toEqual({
      title: Buffer.from(secondTitle, "utf8"),
    });
  });

  it.each([131_071, 131_072, 131_073])("honors the exact %i-byte final JSON boundary", (target) => {
    const id = addGoal("", "2026-10-30");
    const base = projectWeek({ weekStart: MONDAY, timezone: ZONE }, db, { now: () => NOW });
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    db.prepare("UPDATE goals SET title=? WHERE id=?").run("a".repeat(target - baseBytes), id);
    const result = projectWeek({ weekStart: MONDAY, timezone: ZONE }, db, { now: () => NOW });
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (target <= WEEK_JSON_BYTE_LIMIT) {
      expect(bytes).toBe(target);
      expect(result.records[0].titleTruncated).toBe(false);
    } else {
      expect(bytes).toBe(WEEK_JSON_BYTE_LIMIT);
      expect(result.records[0].titleTruncated).toBe(true);
    }
  });

  it("preserves ADR-50 precedence and returns one closed no-partial 500 on database failure", async () => {
    const protectedApp = createApp({ password: "week-secret" });
    await request(protectedApp).get(url()).expect(401);
    await request(protectedApp).get(url()).set("x-draw-password", "week-secret").expect(200);

    db.exec("DROP INDEX idx_time_entries_range");
    try {
      const response = await request(app).get(url()).expect(500).expect("Content-Type", /json/);
      expect(response.body).toEqual({ error: "week-projection-failed" });
    } finally {
      db.exec("CREATE INDEX idx_time_entries_range ON time_entries(started_at, ended_at, id)");
    }
  });
});
