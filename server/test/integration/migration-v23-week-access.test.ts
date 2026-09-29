import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase, type WeekMigrationStage } from "../../src/db.js";
import {
  WEEK_MAX_DAY,
  beginWeekMutation,
  buildWeekProjection,
  collectWeekProjection,
  finishWeekMutation,
  maintainWeekTracked,
  validateV23Contract,
} from "../../src/schemaV23.js";
import { stripV23Schema } from "../schemaFixtures.js";

const schema = fs.readFileSync(fileURLToPath(new URL("../../src/schema.sql", import.meta.url)), "utf8");
const v22 = stripV23Schema(schema);

function open(name: string, sql = v22, version = 22): Database.Database {
  const database = new Database(path.join(process.env.DATA_DIR!, `${name}.db`));
  database.exec(sql);
  database.pragma(`user_version=${version}`);
  database.pragma("foreign_keys=ON");
  database.pragma("trusted_schema=OFF");
  return database;
}

function insertTask(database: Database.Database, title: string, id?: number | bigint): number {
  const result = id === undefined
    ? database.prepare("INSERT INTO tasks(title,category_id,created_at) VALUES (?,1,'created')").run(title)
    : database.prepare("INSERT INTO tasks(id,title,category_id,created_at) VALUES (?, ?,1,'created')").run(id, title);
  return Number(id ?? result.lastInsertRowid);
}

function ready(database: Database.Database): void {
  buildWeekProjection(database);
  database.prepare(
    "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
  ).run();
}

describe("schema v23 compact Week interval projection", () => {
  it("migrates v22 transactionally, stamps last, and produces exact companion/RTree rows", () => {
    const database = open("v23-migrate");
    try {
      const fixed = insertTask(database, "fixed secret title");
      const tracked = insertTask(database, "tracked secret title");
      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
      ).run(fixed, "2026-01-01T10:00:00.000Z", "2026-01-08T10:00:00.000Z");
      database.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
      ).run(tracked, "2026-01-02T12:00:00.000Z", "2026-01-02T12:30:00.000Z");
      database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
        tracked,
        "2026-01-03T12:00:00.000Z",
      );

      const stages: WeekMigrationStage[] = [];
      migrateDatabase(database, { afterWeekStage: (stage) => stages.push(stage) });
      expect(stages).toEqual(["create", "build", "validate", "ready", "stamp"]);
      expect(database.pragma("user_version", { simple: true })).toBe(23);
      expect(database.prepare("SELECT * FROM week_access_state").get()).toEqual({
        singleton: 1,
        projection_format: 1,
        ready: 1,
        source_generation: 0,
        built_generation: 0,
      });
      const rows = database.prepare(
        `SELECT source_kind AS sourceKind,source_id AS sourceId,task_id AS taskId,
                start_ms AS startMs,end_ms AS endMs,start_day AS startDay,end_day AS endDay
         FROM week_interval_access ORDER BY source_kind,source_id`,
      ).all();
      expect(rows).toEqual(collectWeekProjection(database));
      expect(rows).toHaveLength(3);
      expect(rows).not.toContainEqual(expect.objectContaining({ title: expect.anything() }));
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree").get()).toEqual({ n: 3 });
      expect(() => validateV23Contract(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rolls every create/build/validate/ready/stamp fault back to exact stamped v22 source", () => {
    for (const fault of ["create", "build", "validate", "ready", "stamp"] as WeekMigrationStage[]) {
      const database = open(`v23-fault-${fault}`);
      try {
        const task = insertTask(database, `source-${fault}`);
        database.prepare(
          "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
        ).run(task, "2026-02-01T00:00:00.000Z", "2026-02-01T01:00:00.000Z");
        const sourceBefore = database.prepare("SELECT * FROM time_entries").all();
        expect(() => migrateDatabase(database, {
          afterWeekStage(stage) {
            if (stage === fault) throw new Error(`fault:${fault}`);
          },
        })).toThrow(`fault:${fault}`);
        expect(database.pragma("user_version", { simple: true })).toBe(22);
        expect(database.prepare("SELECT * FROM time_entries").all()).toEqual(sourceBefore);
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'week_%'").all()).toEqual([]);
      } finally {
        database.close();
      }
    }
  });

  it("uses lazy 24-byte TEXT admission and an independent interval/day oracle", () => {
    const database = open("v23-lazy", schema, 23);
    database.pragma("foreign_keys=OFF");
    try {
      const valid = insertTask(database, "TOP SECRET title");
      const other = insertTask(database, "another secret");
      const add = database.prepare(
        "INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)",
      );
      add.run(1, valid, "0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.001Z");
      add.run(2, valid, "9999-12-31T23:59:59.998Z", "9999-12-31T23:59:59.999Z");
      add.run(3, other, "2026-01-01T00:00:00.000Z", null);
      add.run(4, valid, "2026-99-99T99:99:99.999Z", null); // malformed exact length
      add.run(5, valid, "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z");
      add.run(6, valid, "2026-01-01T02:00:00.000Z", "2026-01-01T01:00:00.000Z");
      add.run(7, valid, "x".repeat(1_000_000), null);
      add.run(8, valid, Buffer.alloc(1_000_000, 65), null);
      add.run(9, valid, "2026-01-01T00:00:00.000Z", Buffer.alloc(1_000_000, 66));
      add.run(10, 999_999, "2026-01-01T00:00:00.000Z", null); // orphan
      add.run(9_007_199_254_740_992n, valid, "2026-01-01T00:00:00.000Z", null);

      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
      ).run(other, Buffer.from("A".repeat(1_000_000)), Buffer.from("B".repeat(1_000_000)));

      const observed: unknown[] = [];
      const projected = collectWeekProjection(database, (value) => observed.push(value));
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((value) => typeof value === "string" && Buffer.byteLength(value) === 24)).toBe(true);
      expect(projected.map((row) => row.sourceId)).toEqual([1, 2, 3]);
      expect(projected[0]).toMatchObject({ startMs: -62_135_596_800_000, startDay: 0, endDay: 0 });
      expect(projected[1]).toMatchObject({ startMs: 253_402_300_799_998, startDay: WEEK_MAX_DAY, endDay: WEEK_MAX_DAY });
      expect(projected[2]).toMatchObject({ endMs: null, endDay: WEEK_MAX_DAY });
      expect(Object.keys(projected[0]).sort()).toEqual([
        "endDay", "endMs", "sourceId", "sourceKind", "startDay", "startMs", "taskId",
      ]);
      expect(JSON.stringify(projected)).not.toContain("SECRET");
    } finally {
      database.close();
    }
  });

  it("rebuilds dirty logical rows on boot but rejects missing exact trigger structure", () => {
    const database = open("v23-boot-rebuild", schema, 23);
    try {
      const task = insertTask(database, "boot rebuild");
      database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
        task,
        "2026-01-05T00:00:00.000Z",
      );
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 0 });
      migrateDatabase(database);
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT ready,source_generation AS sourceGeneration,built_generation AS builtGeneration FROM week_access_state").get()).toEqual({
        ready: 1, sourceGeneration: 2, builtGeneration: 2,
      });
      database.exec("DROP TRIGGER week_time_entries_ai_dirty");
      expect(() => migrateDatabase(database)).toThrow(/trigger inventory|week_time_entries_ai_dirty|persistent trigger/);
    } finally {
      database.close();
    }
  });

  it("fails generation and index-id exhaustion atomically instead of wrapping", () => {
    const generation = open("v23-generation-overflow", schema, 23);
    try {
      const task = insertTask(generation, "generation overflow");
      generation.prepare(`UPDATE week_access_state SET
        source_generation=9007199254740991,built_generation=9007199254740991,ready=1`).run();
      expect(() => generation.prepare(
        "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
      ).run(task, "2026-01-01T00:00:00.000Z")).toThrow();
      expect(generation.prepare("SELECT COUNT(*) AS n FROM time_entries").get()).toEqual({ n: 0 });
      expect(generation.prepare("SELECT source_generation AS n FROM week_access_state").get()).toEqual({ n: 9_007_199_254_740_991 });
    } finally {
      generation.close();
    }

    const index = open("v23-index-overflow", schema, 23);
    try {
      const task = insertTask(index, "index overflow");
      index.prepare("UPDATE week_access_state SET ready=1,built_generation=source_generation").run();
      index.prepare(`INSERT INTO week_interval_access
        (index_id,source_kind,source_id,task_id,start_ms,end_ms,start_day,end_day)
        VALUES (9007199254740991,2,777,?,-62135596800000,NULL,0,3652058)`).run(task);
      expect(() => index.transaction(() => {
        const token = beginWeekMutation(index);
        const inserted = index.prepare(
          "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
        ).run(task, "2026-01-01T00:00:00.000Z");
        maintainWeekTracked(index, token, [Number(inserted.lastInsertRowid)]);
        finishWeekMutation(index, token);
      })()).toThrow();
      expect(index.prepare("SELECT COUNT(*) AS n FROM time_entries").get()).toEqual({ n: 0 });
      expect(index.prepare("SELECT ready,source_generation AS sourceGeneration,built_generation AS builtGeneration FROM week_access_state").get()).toEqual({
        ready: 1, sourceGeneration: 0, builtGeneration: 0,
      });
    } finally {
      index.close();
    }
  });

  it("marks direct drift dirty, deletes companion/RTree rows, and covers task cascades", () => {
    const database = open("v23-drift", schema, 23);
    try {
      database.prepare(
        "UPDATE week_access_state SET ready=1,built_generation=source_generation WHERE singleton=1",
      ).run();
      const task = insertTask(database, "drift");
      const inserted = database.prepare(
        "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
      ).run(task, "2026-03-01T00:00:00.000Z");
      expect(database.prepare("SELECT ready FROM week_access_state").get()).toEqual({ ready: 0 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 0 });
      ready(database);
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 1 });

      database.prepare("UPDATE time_entries SET ended_at=? WHERE id=?").run(
        "2026-03-01T01:00:00.000Z",
        inserted.lastInsertRowid,
      );
      expect(database.prepare("SELECT ready FROM week_access_state").get()).toEqual({ ready: 0 });
      expect(database.prepare("SELECT end_ms AS endMs FROM week_interval_access").get()).toEqual({ endMs: null });
      database.prepare("DELETE FROM time_entries WHERE id=?").run(inserted.lastInsertRowid);
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree").get()).toEqual({ n: 0 });

      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
      ).run(task, "2026-03-02T00:00:00.000Z", "2026-03-02T01:00:00.000Z");
      database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
        task,
        "2026-03-02T02:00:00.000Z",
      );
      ready(database);
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 2 });
      database.prepare("DELETE FROM tasks WHERE id=?").run(task);
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_access").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT ready FROM week_access_state").get()).toEqual({ ready: 0 });
    } finally {
      database.close();
    }
  });
});
