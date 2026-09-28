import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../../src/db.js";
import { validateV21Contract } from "../../src/schemaV21.js";
import { schemaSqlTokens } from "../../src/schemaV18.js";
import { validateV22Contract } from "../../src/schemaV22.js";
import { stripV22Schema } from "../schemaFixtures.js";

const schema = fs.readFileSync(
  fileURLToPath(new URL("../../src/schema.sql", import.meta.url)),
  "utf8",
);
const v21 = stripV22Schema(schema);

function open(name: string, sql: string, version: number) {
  const database = new Database(path.join(process.env.DATA_DIR!, `${name}.db`));
  database.exec(sql);
  database.pragma(`user_version=${version}`);
  database.pragma("foreign_keys=ON");
  return database;
}

function v22Objects(database: Database.Database) {
  return database
    .prepare(
      `SELECT type,name,sql FROM sqlite_schema
       WHERE name IN ('task_fixed_slots','idx_task_fixed_slots_range','idx_time_entries_range',
                      'idx_tasks_due_date','idx_goals_target_date')
       ORDER BY type,name`,
    )
    .all()
    .map((row) => {
      const object = row as { type: string; name: string; sql: string };
      return { ...object, sql: schemaSqlTokens(object.sql) };
    });
}

describe("schema v22 fixed-slot migration and complete validator", () => {
  it("makes fresh and real v21→v22 artifacts exact equivalents", () => {
    const fresh = open("fresh-v22", schema, 22);
    const migrated = open("migrated-v22", v21, 21);
    try {
      expect(() => validateV21Contract(migrated)).not.toThrow();
      migrateDatabase(migrated);
      expect(migrated.pragma("user_version", { simple: true })).toBe(22);
      expect(v22Objects(migrated)).toEqual(v22Objects(fresh));
      expect(() => validateV22Contract(fresh)).not.toThrow();
      expect(() => validateV22Contract(migrated)).not.toThrow();
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("leaves a valid stamped v21 database unchanged on a DDL collision", () => {
    const database = open("v22-collision", v21, 21);
    try {
      database.exec("CREATE TABLE task_fixed_slots(collision TEXT)");
      expect(() => migrateDatabase(database)).toThrow(/already exists/);
      expect(database.pragma("user_version", { simple: true })).toBe(21);
      expect(() => validateV21Contract(database)).not.toThrow();
      expect(database.prepare("PRAGMA table_info(task_fixed_slots)").all()).toEqual([
        expect.objectContaining({ name: "collision" }),
      ]);
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name='idx_time_entries_range'").get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back relation and earlier indexes when a later migration statement fails", () => {
    const database = open("v22-mid-rollback", v21, 21);
    try {
      // This v22-named index is harmless to the immutable v21 contract but
      // collides only after the new table and first range index were created.
      database.exec(
        "CREATE INDEX idx_time_entries_range ON time_entries(started_at, ended_at, id)",
      );
      expect(() => validateV21Contract(database)).not.toThrow();
      expect(() => migrateDatabase(database)).toThrow(/already exists/);
      expect(database.pragma("user_version", { simple: true })).toBe(21);
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name='task_fixed_slots'").get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name='idx_task_fixed_slots_range'").get(),
      ).toBeUndefined();
      expect(() => validateV21Contract(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects malformed new DDL and exact index-inventory drift", () => {
    const weakTable = open("v22-weak-table", schema, 22);
    const extraIndex = open("v22-extra-index", schema, 22);
    try {
      weakTable.exec("DROP TABLE task_fixed_slots");
      weakTable.exec(`CREATE TABLE task_fixed_slots (
        task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        entry_timezone TEXT NOT NULL,
        CHECK (ends_at >= starts_at)
      )`);
      weakTable.exec(
        "CREATE INDEX idx_task_fixed_slots_range ON task_fixed_slots(starts_at, ends_at, task_id)",
      );
      expect(() => validateV22Contract(weakTable)).toThrow(/task_fixed_slots DDL/);

      extraIndex.exec("CREATE INDEX attacker_slot_zone ON task_fixed_slots(entry_timezone)");
      expect(() => validateV22Contract(extraIndex)).toThrow(/index inventory/);
    } finally {
      weakTable.close();
      extraIndex.close();
    }
  });

  it("validates canonical instants, frozen zones, wall round trips and recurrence absence", () => {
    const database = open("v22-data", schema, 22);
    const task = database
      .prepare("INSERT INTO tasks(title,category_id,created_at) VALUES ('slot',1,'created')")
      .run();
    const id = Number(task.lastInsertRowid);
    const insert = database.prepare(
      "INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,?)",
    );
    try {
      insert.run(id, "0001-01-01T00:00:00.000Z", "0001-01-01T00:01:00.000Z", "UTC");
      expect(() => validateV22Contract(database)).not.toThrow();
      database.prepare("DELETE FROM task_fixed_slots").run();
      insert.run(id, "9999-12-31T23:58:00.000Z", "9999-12-31T23:59:00.000Z", "UTC");
      expect(() => validateV22Contract(database)).not.toThrow();

      database.prepare("UPDATE task_fixed_slots SET entry_timezone='US/Eastern'").run();
      expect(() => validateV22Contract(database)).toThrow(/stored fixed slot|row/);
      database.prepare("UPDATE task_fixed_slots SET entry_timezone='UTC', starts_at='2026-01-01T10:00:00Z'").run();
      expect(() => validateV22Contract(database)).toThrow(/canonical|stored fixed slot/);

      database.prepare(
        "UPDATE task_fixed_slots SET entry_timezone='Europe/Berlin', starts_at='2026-10-25T01:30:00.000Z', ends_at='2026-10-25T02:30:00.000Z'",
      ).run();
      expect(() => validateV22Contract(database)).toThrow(/round trip/);

      database.pragma("ignore_check_constraints=ON");
      database.prepare(
        "UPDATE task_fixed_slots SET entry_timezone='UTC', starts_at='2026-01-01T12:00:00.000Z', ends_at='2026-01-01T11:00:00.000Z'",
      ).run();
      expect(() => validateV22Contract(database)).toThrow(/invalid fixed slot order/);
      database.pragma("ignore_check_constraints=OFF");

      database.prepare("UPDATE task_fixed_slots SET starts_at='2026-01-01T10:00:00.000Z', ends_at='2026-01-01T11:00:00.000Z'").run();
      database.prepare("UPDATE tasks SET recur_every_days=7 WHERE id=?").run(id);
      expect(() => validateV22Contract(database)).toThrow(/both fixed slot and recurrence/);
    } finally {
      database.close();
    }
  });
});
