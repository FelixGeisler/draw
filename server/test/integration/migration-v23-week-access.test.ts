import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase, type WeekMigrationStage } from "../../src/db.js";
import {
  WEEK_MAX_DAY,
  WEEK_PROJECTION_BATCH_SIZE,
  beginWeekMutation,
  buildWeekProjection,
  finishWeekMutation,
  maintainWeekTracked,
  validateV23Contract,
  validateV23Projection,
} from "../../src/schemaV23.js";
import { validateV22Contract } from "../../src/schemaV22.js";
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
      const closed = database.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
      ).run(tracked, "2026-01-02T12:00:00.000Z", "2026-01-02T12:30:00.000Z");
      const opened = database.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
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
      expect(rows).toEqual([
        {
          sourceKind: 0, sourceId: fixed, taskId: fixed,
          startMs: 1_767_261_600_000, endMs: 1_767_866_400_000,
          startDay: 739_616, endDay: 739_623,
        },
        {
          sourceKind: 2, sourceId: Number(closed.lastInsertRowid), taskId: tracked,
          startMs: 1_767_355_200_000, endMs: 1_767_357_000_000,
          startDay: 739_617, endDay: 739_617,
        },
        {
          sourceKind: 2, sourceId: Number(opened.lastInsertRowid), taskId: tracked,
          startMs: 1_767_441_600_000, endMs: null,
          startDay: 739_618, endDay: WEEK_MAX_DAY,
        },
      ]);
      expect(rows).toHaveLength(3);
      expect(rows).not.toContainEqual(expect.objectContaining({ title: expect.anything() }));
      expect(database.prepare("SELECT COUNT(*) AS n FROM week_interval_rtree").get()).toEqual({ n: 3 });
      expect(() => validateV23Contract(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rolls every create/build/validate/ready/stamp fault back to an exact reopened v22 with byte-equivalent source", () => {
    for (const fault of ["create", "build", "validate", "ready", "stamp"] as WeekMigrationStage[]) {
      const name = `v23-fault-${fault}`;
      const databasePath = path.join(process.env.DATA_DIR!, `${name}.db`);
      const database = open(name);
      let reopened: Database.Database | undefined;
      try {
        const task = insertTask(database, `source-${fault}`);
        database.prepare(
          "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
        ).run(task, "2026-02-01T00:00:00.000Z", "2026-02-01T01:00:00.000Z");
        const sourceBefore = database.prepare(`SELECT id,task_id,
          typeof(started_at) AS startType,hex(started_at) AS startBytes,
          typeof(ended_at) AS endType,hex(ended_at) AS endBytes FROM time_entries`).all();
        expect(() => migrateDatabase(database, {
          afterWeekStage(stage) {
            if (stage === fault) throw new Error(`fault:${fault}`);
          },
        })).toThrow(`fault:${fault}`);
        database.close();

        reopened = new Database(databasePath);
        reopened.pragma("foreign_keys=ON");
        reopened.pragma("trusted_schema=OFF");
        expect(reopened.pragma("user_version", { simple: true })).toBe(22);
        expect(() => validateV22Contract(reopened!)).not.toThrow();
        expect(reopened.prepare(`SELECT id,task_id,
          typeof(started_at) AS startType,hex(started_at) AS startBytes,
          typeof(ended_at) AS endType,hex(ended_at) AS endBytes FROM time_entries`).all()).toEqual(sourceBefore);
        expect(reopened.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'week_%'").all()).toEqual([]);
      } finally {
        if (database.open) database.close();
        if (reopened?.open) reopened.close();
      }
    }
  });

  it("uses lazy guards, independent fixed/tracked oracles, and lossless coarse candidates", () => {
    const database = open("v23-lazy", schema, 23);
    database.pragma("foreign_keys=OFF");
    try {
      const fixedLong = insertTask(database, "TOP SECRET fixed long");
      const fixedMidnight = insertTask(database, "TOP SECRET fixed boundary");
      const tracked = insertTask(database, "TOP SECRET tracked");
      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
      ).run(fixedLong, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
      database.prepare(
        "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
      ).run(fixedMidnight, "2026-01-01T23:00:00.000Z", "2026-01-02T00:00:00.000Z");

      const add = database.prepare(
        "INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)",
      );
      add.run(1, tracked, "0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.001Z");
      add.run(2, tracked, "9999-12-31T23:59:59.998Z", "9999-12-31T23:59:59.999Z");
      add.run(3, tracked, "2026-01-03T12:00:00.000Z", null);
      add.run(4, tracked, "2026-99-99T99:99:99.999Z", null); // malformed exact length
      add.run(5, tracked, "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z");
      add.run(6, tracked, "2026-01-01T02:00:00.000Z", "2026-01-01T01:00:00.000Z");
      add.run(7, 999_999, "2026-01-01T00:00:00.000Z", null); // orphan
      add.run(9_007_199_254_740_992n, tracked, "2026-01-01T00:00:00.000Z", null);

      // Crafted/corrupt source can bypass table CHECKs before this runtime sees
      // it. Disable checks only while constructing the lazy-admission matrix.
      database.pragma("ignore_check_constraints=ON");
      const hugeText = "x".repeat(1_000_000);
      const hugeBlob = Buffer.alloc(1_000_000, 65);
      const fixedInvalids = [
        [hugeText, "2026-04-01T01:00:00.000Z"],
        [hugeBlob, "2026-04-01T01:00:00.000Z"],
        ["2026-04-01T00:00:00.000Z", hugeText],
        ["2026-04-01T00:00:00.000Z", hugeBlob],
      ] as const;
      for (const [index, [startsAt, endsAt]] of fixedInvalids.entries()) {
        const task = insertTask(database, `fixed huge ${index}`);
        database.prepare(
          "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')",
        ).run(task, startsAt, endsAt);
      }
      const trackedInvalids = [
        [hugeText, "2026-04-01T01:00:00.000Z"],
        [hugeBlob, "2026-04-01T01:00:00.000Z"],
        ["2026-04-01T00:00:00.000Z", hugeText],
        ["2026-04-01T00:00:00.000Z", hugeBlob],
      ] as const;
      for (const [index, [startedAt, endedAt]] of trackedInvalids.entries()) {
        add.run(20 + index, tracked, startedAt, endedAt);
      }
      database.pragma("ignore_check_constraints=OFF");

      const sourceSnapshot = () => ({
        fixed: database.prepare(
          "SELECT task_id,starts_at,ends_at FROM task_fixed_slots ORDER BY task_id",
        ).all(),
        tracked: database.prepare(
          "SELECT id,task_id,started_at,ended_at FROM time_entries ORDER BY id",
        ).all(),
      });
      const sourceBefore = sourceSnapshot();
      const observed: unknown[] = [];
      buildWeekProjection(database, { timestamp: (value) => observed.push(value) });
      expect(sourceSnapshot()).toEqual(sourceBefore);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every(
        (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") === 24,
      )).toBe(true);

      const projected = database.prepare(`SELECT source_kind AS sourceKind,source_id AS sourceId,
        task_id AS taskId,start_ms AS startMs,end_ms AS endMs,start_day AS startDay,end_day AS endDay
        FROM week_interval_access ORDER BY source_kind,source_id`).all();
      const expected = [
        { sourceKind: 0, sourceId: fixedLong, taskId: fixedLong, startMs: 946_684_800_000,
          endMs: 4_102_444_800_000, startDay: 730_119, endDay: 766_643 },
        { sourceKind: 0, sourceId: fixedMidnight, taskId: fixedMidnight, startMs: 1_767_308_400_000,
          endMs: 1_767_312_000_000, startDay: 739_616, endDay: 739_616 },
        { sourceKind: 2, sourceId: 1, taskId: tracked, startMs: -62_135_596_800_000,
          endMs: -62_135_596_799_999, startDay: 0, endDay: 0 },
        { sourceKind: 2, sourceId: 2, taskId: tracked, startMs: 253_402_300_799_998,
          endMs: 253_402_300_799_999, startDay: WEEK_MAX_DAY, endDay: WEEK_MAX_DAY },
        { sourceKind: 2, sourceId: 3, taskId: tracked, startMs: 1_767_441_600_000,
          endMs: null, startDay: 739_618, endDay: WEEK_MAX_DAY },
      ];
      expect(projected).toEqual(expected);
      expect(JSON.stringify(projected)).not.toContain("SECRET");

      const queries = [
        [-62_135_596_800_000, -62_135_596_799_999],
        [1_767_308_400_000, 1_767_312_000_000],
        [1_767_312_000_000, 1_767_398_400_000], // exact UTC midnight exclusive end
        [2_524_608_000_000, 2_524_694_400_000], // a day in 2050, inside the long fixed interval
        [253_402_300_799_998, 253_402_300_800_000],
      ] as const;
      const minMs = -62_135_596_800_000;
      const dayFor = (ms: number) => Math.floor((ms - minMs) / 86_400_000);
      for (const [queryStart, queryEnd] of queries) {
        const queryStartDay = dayFor(queryStart);
        const queryEndDay = dayFor(queryEnd - 1);
        const candidates = database.prepare(`SELECT a.source_kind AS sourceKind,a.source_id AS sourceId
          FROM week_interval_rtree r JOIN week_interval_access a ON a.index_id=r.index_id
          WHERE r.start_day<=? AND r.end_day>=?`).all(queryEndDay, queryStartDay) as Array<{
            sourceKind: number; sourceId: number;
          }>;
        const candidateKeys = new Set(candidates.map((row) => `${row.sourceKind}:${row.sourceId}`));
        const trulyOverlapping = expected.filter(
          (row) => row.startMs < queryEnd && (row.endMs === null || row.endMs > queryStart),
        );
        for (const row of trulyOverlapping) {
          expect(candidateKeys.has(`${row.sourceKind}:${row.sourceId}`),
            `missing coarse candidate ${row.sourceKind}:${row.sourceId}`).toBe(true);
        }
      }
    } finally {
      database.close();
    }
  }, 30_000);

  it("keeps production rebuild and validation scans to bounded keyset batches", () => {
    const database = open("v23-bounded-batches", schema, 23);
    try {
      const task = insertTask(database, "bounded batch source");
      const insert = database.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.001Z')",
      );
      database.transaction(() => {
        for (let index = 0; index < WEEK_PROJECTION_BATCH_SIZE * 2 + 17; index += 1) {
          insert.run(task);
        }
      })();

      const buildBatches: number[] = [];
      buildWeekProjection(database, { batch: ({ rowCount }) => buildBatches.push(rowCount) });
      database.prepare(
        "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
      ).run();
      const validationBatches: number[] = [];
      validateV23Projection(database, false, {
        batch: ({ rowCount }) => validationBatches.push(rowCount),
      });

      for (const batches of [buildBatches, validationBatches]) {
        expect(batches.length).toBeGreaterThan(2);
        expect(Math.max(...batches)).toBeLessThanOrEqual(WEEK_PROJECTION_BATCH_SIZE);
        expect(batches.reduce((total, count) => total + count, 0)).toBe(
          WEEK_PROJECTION_BATCH_SIZE * 2 + 17,
        );
      }
      expect(database.prepare("SELECT COUNT(*) AS count FROM week_interval_access").get()).toEqual({
        count: WEEK_PROJECTION_BATCH_SIZE * 2 + 17,
      });
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
