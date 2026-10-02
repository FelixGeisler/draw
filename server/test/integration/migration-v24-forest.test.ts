import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateDatabase,
  type ForestMigrationStage,
} from "../../src/db.js";
import { schemaSqlTokens } from "../../src/schemaV18.js";
import { buildWeekProjection } from "../../src/schemaV23.js";
import {
  validateV24ClassifiedRows,
  validateV24Contract,
} from "../../src/schemaV24.js";
import { stripV24Schema } from "../schemaFixtures.js";

const schema = fs.readFileSync(fileURLToPath(new URL("../../src/schema.sql", import.meta.url)), "utf8");
const v23 = stripV24Schema(schema);

function open(name: string, sql = v23, version = 23): Database.Database {
  const database = new Database(path.join(process.env.DATA_DIR!, `${name}.db`));
  database.exec(sql);
  database.pragma(`user_version=${version}`);
  database.pragma("foreign_keys=ON");
  database.pragma("trusted_schema=OFF");
  return database;
}

function task(database: Database.Database): number {
  return Number(database.prepare(
    "INSERT INTO tasks(title,category_id,created_at) VALUES ('forest migration',1,'2026-01-01T00:00:00.000Z')",
  ).run().lastInsertRowid);
}

function schemaSnapshot(database: Database.Database): unknown[] {
  return (database.prepare(
    "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name",
  ).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>).map(
    (row) => ({ ...row, sql: row.sql === null ? null : schemaSqlTokens(row.sql) }),
  );
}

function readyWeek(database: Database.Database): void {
  buildWeekProjection(database);
  database.prepare(
    "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
  ).run();
}

describe("schema v24 session outcomes", () => {
  it("migrates v23 atomically, leaves legacy history unclassified, and equals the fresh schema", () => {
    const migrated = open("v24-migrated");
    const fresh = open("v24-fresh", schema, 24);
    try {
      const taskId = task(migrated);
      migrated.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
      ).run(taskId, "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z");
      migrated.prepare("INSERT INTO time_entries(task_id,started_at) VALUES (?,?)").run(
        taskId,
        "2026-01-02T00:00:00.000Z",
      );

      migrateDatabase(migrated);
      expect(migrated.pragma("user_version", { simple: true })).toBe(24);
      expect(migrated.prepare(
        "SELECT ended_at AS endedAt,end_reason AS endReason FROM time_entries ORDER BY id",
      ).all()).toEqual([
        { endedAt: "2026-01-01T01:00:00.000Z", endReason: null },
        { endedAt: null, endReason: null },
      ]);
      readyWeek(fresh);
      expect(schemaSnapshot(migrated)).toEqual(schemaSnapshot(fresh));
      expect(() => validateV24Contract(migrated)).not.toThrow();
      expect(() => validateV24Contract(fresh)).not.toThrow();
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it("rolls create, validation, and final-stamp faults back to exact v23", () => {
    for (const fault of ["create", "validate", "stamp"] as ForestMigrationStage[]) {
      const database = open(`v24-fault-${fault}`);
      try {
        readyWeek(database);
        const before = schemaSnapshot(database);
        const state = database.prepare("SELECT * FROM week_access_state").get();
        expect(() => migrateDatabase(database, {
          afterForestStage(stage) {
            if (stage === fault) throw new Error(`fault:${fault}`);
          },
        })).toThrow(`fault:${fault}`);
        expect(database.pragma("user_version", { simple: true })).toBe(23);
        expect(schemaSnapshot(database)).toEqual(before);
        expect(database.prepare("SELECT * FROM week_access_state").get()).toEqual(state);
      } finally {
        database.close();
      }
    }
  });

  it("admits zero duration, omits it from Week, and rejects every malformed classified domain", () => {
    const database = open("v24-classified", schema, 24);
    try {
      const taskId = task(database);
      database.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,?,'done')",
      ).run(taskId, "0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z");
      readyWeek(database);
      expect(database.prepare(
        "SELECT COUNT(*) AS n FROM week_interval_access WHERE source_kind=2",
      ).get()).toEqual({ n: 0 });
      expect(() => validateV24Contract(database)).not.toThrow();

      const cases: Array<[string, unknown, unknown, unknown]> = [
        ["bad-start", "2026-99-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "done"],
        ["bad-end", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.00Z", "stop"],
        ["reverse", "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "done"],
        ["reason", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "other"],
        ["blob", Buffer.alloc(24), "2026-01-01T00:00:00.000Z", "done"],
      ];
      for (const [name, startedAt, endedAt, reason] of cases) {
        database.pragma("ignore_check_constraints=ON");
        const result = database.prepare(
          "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?)",
        ).run(taskId, startedAt, endedAt, reason);
        database.pragma("ignore_check_constraints=OFF");
        expect(() => validateV24ClassifiedRows(database), name).toThrow(/schema v24 contract/);
        expect(() => migrateDatabase(database), `${name} startup`).toThrow(/schema v24 contract/);
        database.prepare("DELETE FROM time_entries WHERE id=?").run(result.lastInsertRowid);
      }

      database.prepare(
        "INSERT INTO time_entries(id,task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?,?)",
      ).run(
        9_007_199_254_740_991,
        taskId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "stop",
      );
      expect(() => validateV24ClassifiedRows(database)).not.toThrow();
      database.prepare("DELETE FROM time_entries WHERE id=9007199254740991").run();

      database.prepare(
        "INSERT INTO time_entries(id,task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?,?)",
      ).run(
        9_007_199_254_740_992n,
        taskId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "done",
      );
      expect(() => validateV24ClassifiedRows(database)).toThrow(/storage domain/);
      database.prepare("DELETE FROM time_entries WHERE id>9007199254740991").run();

      database.pragma("ignore_check_constraints=ON");
      const openReason = database.prepare(
        "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,NULL,'stop')",
      ).run(taskId, "2026-01-01T00:00:00.000Z");
      database.pragma("ignore_check_constraints=OFF");
      expect(() => validateV24ClassifiedRows(database)).toThrow(/storage domain/);
      database.prepare("DELETE FROM time_entries WHERE id=?").run(openReason.lastInsertRowid);
    } finally {
      database.close();
    }
  });

  it("validates classified rows in bounded keyset batches", () => {
    const database = open("v24-batches", schema, 24);
    try {
      const taskId = task(database);
      const insert = database.prepare(
        `INSERT INTO time_entries(task_id,started_at,ended_at,end_reason)
         VALUES (?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.001Z','done')`,
      );
      database.transaction(() => {
        for (let index = 0; index < 530; index += 1) insert.run(taskId);
      })();
      const batches: number[] = [];
      validateV24ClassifiedRows(database, { batch: ({ rowCount }) => batches.push(rowCount) });
      expect(batches).toEqual([256, 256, 18]);
    } finally {
      database.close();
    }
  });
});
