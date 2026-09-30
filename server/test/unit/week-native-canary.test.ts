import fs from "node:fs";
import path from "node:path";
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

  it("runs the exact readonly/file-must-exist/query-only/pragmas connection contract", async () => {
    await import("../../src/db.js");
    const workerSource = fs.readFileSync(path.join(process.cwd(), "src/weekWorker.ts"), "utf8");
    expect(workerSource.match(/new Database\(/g)).toHaveLength(1);
    expect(workerSource).toContain("{ readonly: true, fileMustExist: true }");

    const databasePath = path.join(process.env.DATA_DIR!, "app.db");
    const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      reader.unsafeMode(false);
      reader.pragma("trusted_schema = OFF");
      reader.pragma("query_only = ON");
      reader.pragma("cache_size = -2048");
      reader.pragma("temp_store = FILE");
      expect(reader.pragma("query_only", { simple: true })).toBe(1);
      expect(reader.pragma("trusted_schema", { simple: true })).toBe(0);
      expect(reader.pragma("cache_size", { simple: true })).toBe(-2048);
      expect(reader.pragma("temp_store", { simple: true })).toBe(1);
      expect(() => reader.prepare("UPDATE tasks SET title=title WHERE id=1").run()).toThrow(/readonly|read-only/i);
      expect(() => reader.exec("CREATE TEMP TABLE forbidden(value)")).toThrow(/readonly|query only/i);
      expect(reader.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual(expect.objectContaining({ n: expect.any(Number) }));
    } finally {
      reader.close();
    }
    expect(reader.open).toBe(false);
    expect(() => new Database(`${databasePath}.missing`, { readonly: true, fileMustExist: true })).toThrow();
  });

  it("keeps identity selection title-free and one-result prefix reads bounded before IPC", () => {
    const workerSource = fs.readFileSync(path.join(process.cwd(), "src/weekWorker.ts"), "utf8");
    expect(WEEK_IDENTITY_SQL).not.toMatch(/\b(?:title|notes|description|outcome|materials)\b/i);
    expect(workerSource).toContain("substr(CAST(title AS BLOB),1,?) AS prefix");
    expect(workerSource).toContain("titleStatements[row.recordKind].get(prefixLimit, sourceId)");
    expect(workerSource).not.toContain("titleStatements[row.recordKind].all");
    expect(workerSource.indexOf("identities = database.prepare(WEEK_QUERY_SQL).all(params)")).toBeLessThan(
      workerSource.indexOf("const fetched = titleFor(identity, titleBudget + 4)"),
    );
    expect(workerSource).toContain("for (const identity of identities.slice(0, WEEK_PAGE_SIZE))");
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
