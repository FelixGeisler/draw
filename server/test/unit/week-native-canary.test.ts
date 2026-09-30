import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSafeDatabase } from "../../src/safeDatabase.js";
import { WEEK_IDENTITY_SQL } from "../../src/weekQuery.js";
import { resolveWeek } from "../../src/weekTime.js";
import { createFixtureDatabase } from "../databaseFixture.js";

/** Repeated on Windows and Linux: these native escape paths justify ADR-75's facade. */
describe("pinned SQLite RTree/native capability canary", () => {
  it("pins the production four-branch RTree/index and bounded top-N plan", async () => {
    await import("../../src/db.js");
    const native = createFixtureDatabase();
    try {
      const week = resolveWeek("2026-10-26", "Europe/Berlin")!;
      const params: Record<string, number | string> = {
        rangeStart: week.rangeStartMs,
        rangeEnd: week.rangeEndMs,
        rangeStartDay: Math.trunc((week.rangeStartMs + 62_135_596_800_000) / 86_400_000),
        rangeEndDay: Math.trunc((week.rangeEndMs - 1 + 62_135_596_800_000) / 86_400_000),
        requestNow: Date.parse("2026-10-29T12:00:00.000Z"),
        hasAfter: 0,
        afterAnchor: week.rangeStartMs,
        afterRank: 0,
        afterId: 0,
      };
      week.dates.forEach((value, index) => { params[`d${index}`] = value; });
      week.midnightMs.forEach((value, index) => { params[`m${index}`] = value; });
      const plan = native.prepare(`EXPLAIN QUERY PLAN ${WEEK_IDENTITY_SQL}`).all(params) as { detail: string }[];
      const details = plan.map(({ detail }) => detail).join("\n");
      expect(details.match(/SCAN r VIRTUAL TABLE INDEX/g)).toHaveLength(2);
      expect(details).toContain("SEARCH t USING INDEX idx_tasks_due_date");
      expect(details).toContain("SEARCH g USING INDEX idx_goals_target_date");
      expect(details).not.toMatch(/SCAN (?:task_fixed_slots|time_entries)/);

      const opcodes = native.prepare(`EXPLAIN ${WEEK_IDENTITY_SQL}`).all(params) as Array<{
        opcode: string; p1: number; p2: number; p3: number; p4: string | null;
      }>;
      expect(opcodes.some((row) => row.opcode === "Integer" && row.p1 === 101)).toBe(true);
      expect(WEEK_IDENTITY_SQL.match(/UNION ALL/g)).toHaveLength(3);
      expect(WEEK_IDENTITY_SQL.match(/@hasAfter=0/g)).toHaveLength(4);
      expect(WEEK_IDENTITY_SQL).not.toMatch(/\b(?:OFFSET|DISTINCT|GROUP BY|UNION(?! ALL))\b/);
    } finally {
      native.close();
    }
  });

  it("characterizes selected large-title native work without a pass/fail resource threshold", () => {
    const native = new Database(":memory:");
    try {
      native.exec("CREATE TABLE titles(id INTEGER PRIMARY KEY,title TEXT NOT NULL)");
      native.prepare("INSERT INTO titles(title) VALUES (?)").run("x".repeat(2 * 1024 * 1024));
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      const row = native.prepare(`SELECT typeof(title) AS storageType,
        octet_length(title) AS byteLength,
        substr(CAST(title AS BLOB),1,1028) AS prefix FROM titles WHERE id=1`).get() as {
          storageType: string; byteLength: number; prefix: Buffer;
        };
      const observation = {
        platform: process.platform,
        elapsedMs: performance.now() - started,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
      };
      console.info("[week-title-characterization]", JSON.stringify(observation));
      expect(row).toMatchObject({ storageType: "text", byteLength: 2 * 1024 * 1024 });
      expect(row.prefix).toHaveLength(1028);
      expect(Object.values(observation).every((value) => typeof value === "string" || Number.isFinite(value))).toBe(true);
    } finally {
      native.close();
    }
  });

  it("confirms native recovery and virtual writes while the facade blocks them", () => {
    const native = new Database(":memory:");
    try {
      native.unsafeMode(false);
      native.exec("CREATE VIRTUAL TABLE week_interval_rtree USING rtree_i32(index_id,start_day,end_day)");
      const statement = native.prepare("SELECT 1");
      const transaction = native.transaction(() => undefined);
      expect((statement as unknown as { database: unknown }).database).toBe(native);
      expect((transaction as unknown as { database: unknown }).database).toBe(native);
      expect(() => native.prepare(
        "INSERT INTO week_interval_rtree(index_id,start_day,end_day) VALUES (1,2,3)",
      ).run()).not.toThrow();
      expect(() => native.prepare(
        "INSERT INTO week_interval_rtree_node(nodeno,data) VALUES (2,zeroblob(1228))",
      ).run()).toThrow();

      let resolutions = 0;
      const safe = createSafeDatabase(() => {
        resolutions += 1;
        return native;
      });
      for (const sql of [
        "SELECT * FROM week_interval_rtree",
        "DELETE FROM week_interval_rtree WHERE index_id=1",
        "SELECT * FROM week_interval_rtree_node",
      ]) expect(() => safe.prepare(sql)).toThrow(/unsafe SQL/);
      expect(resolutions).toBe(0);
      expect("database" in safe.prepare("SELECT 1")).toBe(false);
      expect("database" in safe.transaction(() => undefined)).toBe(false);
    } finally {
      native.close();
    }
  });
});
