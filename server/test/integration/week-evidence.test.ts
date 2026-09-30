import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { shutdownWeekProjection } from "../../src/db.js";
import { buildWeekProjection } from "../../src/schemaV23.js";
import { testDb } from "../helpers.js";

const app = createApp();
const endpoint = (weekStart: string, cursor?: string) =>
  `/api/calendar/week?weekStart=${weekStart}&timezone=UTC${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

async function nativeWrite(write: (database: Awaited<ReturnType<typeof testDb>>) => void) {
  const database = await testDb();
  try { write(database); } finally { database.close(); }
}

async function ready() {
  await nativeWrite((database) => database.transaction(() => {
    buildWeekProjection(database);
    database.prepare("UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1").run();
  })());
}

async function allPages(weekStart: string) {
  const records: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const response = await request(app).get(endpoint(weekStart, cursor)).expect(200);
    records.push(...response.body.records);
    cursor = response.body.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

afterAll(async () => shutdownWeekProjection());

describe("Phase 2A deterministic count, body, and source-oracle evidence", () => {
  it("proves exact 99/100/101 count boundaries and deep duplicate-free continuation", async () => {
    await nativeWrite((database) => {
      const insert = database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,'open','2026-01-01T00:00:00.000Z')");
      database.transaction(() => {
        for (const [base, count, date] of [
          [10_000, 99, "2030-01-04"],
          [11_000, 100, "2030-01-11"],
          [12_000, 101, "2030-01-18"],
          [13_000, 205, "2030-01-25"],
        ] as const) for (let index = 0; index < count; index += 1) insert.run(base + index, `identity-${base + index}`, date);
        for (let index = 0; index < 300; index += 1) insert.run(20_000 + index, `sparse-${index}`, "2040-01-01");
      })();
    });

    for (const [week, count, base] of [
      ["2029-12-31", 99, 10_000],
      ["2030-01-07", 100, 11_000],
      ["2030-01-14", 101, 12_000],
      ["2030-01-21", 205, 13_000],
    ] as const) {
      const first = await request(app).get(endpoint(week)).expect(200);
      expect(first.body.records).toHaveLength(Math.min(100, count));
      expect(first.body.nextCursor === null).toBe(count <= 100);
      const records = await allPages(week);
      expect(records.map((row) => row.id)).toEqual(Array.from({ length: count }, (_, index) => base + index));
      expect(new Set(records.map((row) => `${row.kind}:${row.id}`)).size).toBe(count);
    }
  });

  it("proves exact 131071/131072/131073 final JSON behavior and intact SQLite storage", async () => {
    const cases = [
      { id: 30_001, week: "2031-01-06", due: "2031-01-08", bytes: 131_071, truncated: false },
      { id: 30_002, week: "2031-01-13", due: "2031-01-15", bytes: 131_072, truncated: false },
      { id: 30_003, week: "2031-01-20", due: "2031-01-22", bytes: 131_073, truncated: true },
    ] as const;
    for (const fixture of cases) {
      await nativeWrite((database) => database.prepare(
        "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?, 'x',1,?,'open','2026-01-01T00:00:00.000Z')",
      ).run(fixture.id, fixture.due));
      const empty = await request(app).get(endpoint(fixture.week)).expect(200);
      const overhead = Buffer.byteLength(empty.text, "utf8") - 1;
      const sourceTitle = "x".repeat(fixture.bytes - overhead);
      await nativeWrite((database) => database.prepare("UPDATE tasks SET title=? WHERE id=?").run(sourceTitle, fixture.id));

      const response = await request(app).get(endpoint(fixture.week)).expect(200);
      expect(Buffer.byteLength(response.text, "utf8")).toBe(Math.min(fixture.bytes, 131_072));
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].titleTruncated).toBe(fixture.truncated);
      expect(sourceTitle.startsWith(response.body.records[0].title)).toBe(true);
      const database = await testDb();
      expect(database.prepare("SELECT title FROM tasks WHERE id=?").get(fixture.id)).toEqual({ title: sourceTitle });
      database.close();
    }
  });

  it("defers an intact record, handles escaping/controls/combining/emoji boundaries, and serializes no suffix", async () => {
    const large = `${"a".repeat(130_000)}END-OF-SOURCE`;
    const deferred = "b".repeat(2_000);
    await nativeWrite((database) => {
      const insert = database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,'open','2026-01-01T00:00:00.000Z')");
      insert.run(31_001, large, "2031-02-05");
      insert.run(31_002, deferred, "2031-02-05");
      for (const [id, title] of [
        [31_010, "quote-\"-slash-\\-control-\u0000\n"],
        [31_011, `combining-e\u0301-${"😀".repeat(32)}-suffix`],
      ] as const) insert.run(id, title, "2031-02-12");
    });

    const first = await request(app).get(endpoint("2031-02-03")).expect(200);
    expect(first.body.records).toHaveLength(1);
    expect(first.body.records[0]).toMatchObject({ id: 31_001, title: large, titleTruncated: false });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app).get(endpoint("2031-02-03", first.body.nextCursor)).expect(200);
    expect(second.body.records).toEqual([expect.objectContaining({ id: 31_002, title: deferred })]);

    const escaped = await request(app).get(endpoint("2031-02-10")).expect(200);
    expect(escaped.body.records.map((row: { title: string }) => row.title)).toEqual([
      "quote-\"-slash-\\-control-\u0000\n",
      `combining-e\u0301-${"😀".repeat(32)}-suffix`,
    ]);
    expect(JSON.parse(escaped.text)).toEqual(escaped.body);

    const hostile = `${"😀".repeat(40_000)}SECRET-SUFFIX-MUST-NOT-SERIALIZE`;
    await nativeWrite((database) => database.prepare(
      "INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (31020,?,1,'2031-02-19','open','2026-01-01T00:00:00.000Z')",
    ).run(hostile));
    const bounded = await request(app).get(endpoint("2031-02-17")).expect(200);
    expect(bounded.body.records[0].titleTruncated).toBe(true);
    expect(hostile.startsWith(bounded.body.records[0].title)).toBe(true);
    expect(bounded.text).not.toContain("SECRET-SUFFIX-MUST-NOT-SERIALIZE");
    expect(bounded.body.records[0].title.endsWith("�")).toBe(false);
  });

  it("matches an independent eligibility/overlap/order oracle across dual facets and interval edges", async () => {
    await nativeWrite((database) => {
      const task = database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,?, '2026-01-01T00:00:00.000Z')");
      task.run(32_001, "dual-same", "2031-03-05", "open");
      task.run(32_002, "dual-different", "2031-03-08", "open");
      task.run(32_003, "done-fixed", "2031-03-06", "done");
      task.run(32_004, "archived", null, "archived");
      task.run(32_005, "tracked-source", null, "open");
      const fixed = database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')");
      fixed.run(32_001, "2031-03-05T08:00:00.000Z", "2031-03-05T09:00:00.000Z");
      fixed.run(32_002, "2031-03-03T01:00:00.000Z", "2031-03-03T03:00:00.000Z");
      fixed.run(32_003, "2031-03-02T23:00:00.000Z", "2031-03-03T01:00:00.000Z");
      fixed.run(32_004, "2031-03-04T01:00:00.000Z", "2031-03-04T02:00:00.000Z");
      const tracked = database.prepare("INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)");
      tracked.run(33_001, 32_005, "2031-03-02T22:00:00.000Z", "2031-03-03T00:00:00.001Z");
      tracked.run(33_002, 32_005, "2031-03-04T10:00:00.000Z", "2031-03-04T11:00:00.000Z");
      tracked.run(33_003, 32_005, "2031-03-04T10:00:00.000Z", "2031-03-04T10:30:00.000Z");
      tracked.run(33_004, 32_005, "2031-03-10T00:00:00.000Z", "2031-03-10T01:00:00.000Z");
      tracked.run(33_005, 32_005, "2031-03-02T22:00:00.000Z", "2031-03-03T00:00:00.000Z");
      tracked.run(33_006, 32_005, "2031-03-05T08:30:00.000Z", "2031-03-05T09:30:00.000Z");
      for (let index = 0; index < 50; index += 1) {
        task.run(32_100 + index, `coarse-false-positive-${index}`, null, "open");
        fixed.run(32_100 + index, "2031-03-02T22:00:00.000Z", "2031-03-02T23:00:00.000Z");
      }
      database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (34001,'goal','2031-03-06','active','2026-01-01T00:00:00.000Z')").run();
    });
    await ready();

    const response = await request(app).get(endpoint("2031-03-03")).expect(200);
    const oracle = [
      "task:32003", "tracked:33001", "task:32002", "tracked:33002", "tracked:33003",
      "task:32001", "tracked:33006", "goal:34001",
    ];
    expect(response.body.records.map((row: { kind: string; id: number }) => `${row.kind}:${row.id}`)).toEqual(oracle);
    expect(response.body.records.find((row: { id: number }) => row.id === 32_001).deadline).toEqual({ date: "2031-03-05" });
    expect(response.body.records.find((row: { id: number }) => row.id === 32_003).deadline).toBeNull();
    expect(response.body.records.some((row: { id: number }) =>
      row.id === 32_004 || row.id === 33_004 || row.id === 33_005)).toBe(false);
    const berlin = await request(app)
      .get("/api/calendar/week?weekStart=2031-03-03&timezone=Europe%2FBerlin")
      .expect(200);
    expect(berlin.body.records.some((row: { id: number }) => row.id >= 32_100 && row.id < 32_150)).toBe(false);
  });

  it("excludes restored hostile timestamp/identity domains while preserving an eligible deadline", async () => {
    await nativeWrite((database) => {
      database.pragma("ignore_check_constraints = ON");
      database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (36001,'deadline survives malformed fixed',1,'2031-03-19','open','2026-01-01T00:00:00.000Z')").run();
      database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (36001,'0000-01-01T00:00:00.000Z','2031-03-19T02:00:00.000Z','UTC')").run();
      const tracked = database.prepare("INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)");
      for (const [id, start, end] of [
        [36_010, "+010000-01-01T00:00:00.000Z", "2031-03-19T02:00:00.000Z"],
        [36_011, "31-03-19T00:00:00.000Z", "2031-03-19T02:00:00.000Z"],
        [36_012, "2031-02-30T00:00:00.000Z", "2031-03-19T02:00:00.000Z"],
        [36_013, "2031-03-19T00:00:00.1234Z", "2031-03-19T02:00:00.000Z"],
        [36_014, "2031-03-19T00:00:00.000+00:00", "2031-03-19T02:00:00.000Z"],
        [36_015, "2031-03-19T03:00:00.000Z", "2031-03-19T02:00:00.000Z"],
        [36_016, "x".repeat(100_000), null],
        [36_017, "2031-03-19T00:00:00.000Z", "2031-03-19T00:00:00.000Z"],
      ] as const) tracked.run(id, 36_001, start, end);
      tracked.run(9_007_199_254_740_992, 36_001, "2031-03-19T00:00:00.000Z", "2031-03-19T01:00:00.000Z");
      tracked.run(36_018, 36_001, "2031-03-20T00:00:00.000Z", null);
      database.transaction(() => {
        buildWeekProjection(database);
        database.prepare("UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1").run();
      })();
      database.pragma("ignore_check_constraints = OFF");
    });
    const response = await request(app).get(endpoint("2031-03-17")).expect(200);
    expect(response.body.records).toEqual([
      expect.objectContaining({ kind: "task", id: 36_001, fixed: null, deadline: { date: "2031-03-19" } }),
    ]);
  });

  it("observes coherent old/new WAL snapshots and a dirty post-commit state under a writer", async () => {
    const writer = await testDb();
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (35001,'uncommitted','2031-03-12','active','2026-01-01T00:00:00.000Z')").run();
      const oldSnapshot = await request(app).get(endpoint("2031-03-10")).expect(200);
      expect(oldSnapshot.body.records.some((row: { id: number }) => row.id === 35_001)).toBe(false);
      writer.exec("COMMIT");
      const newSnapshot = await request(app).get(endpoint("2031-03-10")).expect(200);
      expect(newSnapshot.body.records.some((row: { id: number }) => row.id === 35_001)).toBe(true);

      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE task_fixed_slots SET ends_at='2031-03-05T09:30:00.000Z' WHERE task_id=32001").run();
      const coherentOld = await request(app).get(endpoint("2031-03-03")).expect(200);
      expect(coherentOld.body.records.find((row: { id: number }) => row.id === 32_001).fixed.endsAt)
        .toBe("2031-03-05T09:00:00.000Z");
      writer.exec("COMMIT");
      await request(app).get(endpoint("2031-03-03")).expect(503, { error: "week-index-unavailable" });
      await ready();
      const coherentNew = await request(app).get(endpoint("2031-03-03")).expect(200);
      expect(coherentNew.body.records.find((row: { id: number }) => row.id === 32_001).fixed.endsAt)
        .toBe("2031-03-05T09:30:00.000Z");
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
