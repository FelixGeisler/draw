import type Database from "better-sqlite3";
import { SCHEDULE_TIME_ZONES } from "../../shared/scheduleTimezones.js";
import { schemaSqlTokens } from "./schemaV18.js";
import { validateV21Contract } from "./schemaV21.js";
import {
  assertScheduleTimeZoneRuntime,
  validateStoredFixedSlot,
} from "./services/fixedSlots.js";

export const TASK_FIXED_SLOTS_SQL = `CREATE TABLE task_fixed_slots (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  entry_timezone TEXT NOT NULL,
  CHECK (ends_at > starts_at)
)`;

export const V22_INDEX_SQL = [
  "CREATE INDEX idx_task_fixed_slots_range ON task_fixed_slots(starts_at, ends_at, task_id)",
  "CREATE INDEX idx_time_entries_range ON time_entries(started_at, ended_at, id)",
  "CREATE INDEX idx_tasks_due_date ON tasks(due_date, id)",
  "CREATE INDEX idx_goals_target_date ON goals(target_date, id)",
] as const;

function objectSql(
  database: Database.Database,
  type: "table" | "index",
  name: string,
): string | undefined {
  return (
    database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?")
      .get(type, name) as { sql: string | null } | undefined
  )?.sql ?? undefined;
}

function exactSql(
  database: Database.Database,
  type: "table" | "index",
  name: string,
  expected: string,
): void {
  const actual = objectSql(database, type, name);
  if (!actual || schemaSqlTokens(actual).join("\0") !== schemaSqlTokens(expected).join("\0")) {
    throw new Error(`schema v22 contract mismatch: ${name} DDL`);
  }
}

function columns(database: Database.Database, table: string): unknown[][] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>
  ).map((column) => [
    column.name,
    column.type.toUpperCase(),
    column.notnull,
    column.dflt_value,
    column.pk,
  ]);
}

function indexInventory(database: Database.Database, table: string): unknown[][] {
  return (
    database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>
  )
    .map((index) => [index.name, index.unique, index.origin, index.partial])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

function foreignKeys(database: Database.Database, table: string): unknown[][] {
  return (
    database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>
  ).map((key) => [
    key.id,
    key.seq,
    key.table,
    key.from,
    key.to,
    key.on_update,
    key.on_delete,
    key.match,
  ]);
}

export const V22_FIXED_SLOT_VALIDATION_BATCH_SIZE = 256;

export type V22ValidationHooks = Readonly<{
  fixedSlotBatch?: (batch: Readonly<{ rowCount: number }>) => void;
}>;

/** Independent complete schema-v22 validator; v21 remains immutable. */
export function validateV22Contract(
  database: Database.Database,
  hooks: V22ValidationHooks = {},
): void {
  validateV21Contract(database);
  assertScheduleTimeZoneRuntime();
  exactSql(database, "table", "task_fixed_slots", TASK_FIXED_SLOTS_SQL);
  for (const sql of V22_INDEX_SQL) {
    const name = /^CREATE INDEX (\S+)/.exec(sql)?.[1];
    if (!name) throw new Error("schema v22 contract mismatch: index declaration");
    exactSql(database, "index", name, sql);
  }

  const expectedColumns = [
    ["task_id", "INTEGER", 0, null, 1],
    ["starts_at", "TEXT", 1, null, 0],
    ["ends_at", "TEXT", 1, null, 0],
    ["entry_timezone", "TEXT", 1, null, 0],
  ];
  if (JSON.stringify(columns(database, "task_fixed_slots")) !== JSON.stringify(expectedColumns)) {
    throw new Error("schema v22 contract mismatch: task_fixed_slots columns");
  }
  const expectedIndexes: Record<string, unknown[][]> = {
    task_fixed_slots: [["idx_task_fixed_slots_range", 0, "c", 0]],
    time_entries: [
      ["idx_time_entries_range", 0, "c", 0],
      ["idx_time_entries_task", 0, "c", 0],
    ],
    tasks: [
      ["idx_tasks_due_date", 0, "c", 0],
      ["idx_tasks_parent", 0, "c", 0],
      ["idx_tasks_status", 0, "c", 0],
    ],
    goals: [["idx_goals_target_date", 0, "c", 0]],
  };
  for (const [table, expected] of Object.entries(expectedIndexes)) {
    if (JSON.stringify(indexInventory(database, table)) !== JSON.stringify(expected)) {
      throw new Error(`schema v22 contract mismatch: ${table} index inventory`);
    }
  }

  const expectedForeignKeys = [
    [0, 0, "tasks", "task_id", "id", "NO ACTION", "CASCADE", "NONE"],
  ];
  if (
    JSON.stringify(foreignKeys(database, "task_fixed_slots")) !==
    JSON.stringify(expectedForeignKeys)
  ) {
    throw new Error("schema v22 contract mismatch: task_fixed_slots foreign key inventory");
  }

  // Storage class and byte length are admitted lazily in SQL before either
  // timestamp can cross into the strict JS parser. This remains load-bearing
  // when v23 inherits the v22 source contract: huge TEXT/BLOB source is
  // rejected without materializing it in application code.
  const timestampGuard = `
    CASE WHEN typeof(starts_at)='text'
         THEN CASE WHEN octet_length(starts_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
    AND CASE WHEN typeof(ends_at)='text'
             THEN CASE WHEN octet_length(ends_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1`;
  const unsafeTimestamp = database
    .prepare(`SELECT task_id FROM task_fixed_slots WHERE NOT (${timestampGuard}) LIMIT 1`)
    .get() as { task_id: number } | undefined;
  if (unsafeTimestamp) {
    throw new Error(
      `schema v22 contract mismatch: stored fixed slot row ${unsafeTimestamp.task_id}: timestamp storage or byte length`,
    );
  }
  // entry_timezone acceptance is exactly the existing checked-in registry.
  // Prove membership in SQLite before selecting a value so a crafted
  // unrestricted TEXT/BLOB cannot cross into JavaScript. The finite keyset is
  // mechanically derived from that registry; no separate byte threshold or
  // compatibility policy is introduced here.
  const zonePlaceholders = SCHEDULE_TIME_ZONES.map(() => "?").join(",");
  const timezoneGuard = `CASE WHEN typeof(entry_timezone)='text'
    THEN CASE WHEN entry_timezone IN (${zonePlaceholders}) THEN 1 ELSE 0 END ELSE 0 END=1`;
  const unsafeTimezone = database
    .prepare(`SELECT task_id FROM task_fixed_slots WHERE NOT (${timezoneGuard}) LIMIT 1`)
    .get(...SCHEDULE_TIME_ZONES) as { task_id: number } | undefined;
  if (unsafeTimezone) {
    throw new Error(
      `schema v22 contract mismatch: stored fixed slot row ${unsafeTimezone.task_id}: entry_timezone`,
    );
  }

  const fixedSlots = database.prepare(`SELECT task_id, CAST(task_id AS TEXT) AS task_id_key,
      starts_at, ends_at, entry_timezone
    FROM task_fixed_slots
    WHERE (? IS NULL OR task_id > CAST(? AS INTEGER)) AND ${timestampGuard} AND ${timezoneGuard}
    ORDER BY task_id LIMIT ?`);
  // The decimal key preserves every signed 64-bit INTEGER PRIMARY KEY exactly
  // even when the native binding's default numeric row mode cannot.
  let afterTaskId: string | null = null;
  for (;;) {
    const rows = fixedSlots.all(
      afterTaskId,
      afterTaskId,
      ...SCHEDULE_TIME_ZONES,
      V22_FIXED_SLOT_VALIDATION_BATCH_SIZE,
    ) as Array<{
      task_id: number;
      task_id_key: string;
      starts_at: string;
      ends_at: string;
      entry_timezone: string;
    }>;
    if (rows.length === 0) break;
    hooks.fixedSlotBatch?.(Object.freeze({ rowCount: rows.length }));
    for (const row of rows) {
      afterTaskId = row.task_id_key;
      try {
        validateStoredFixedSlot(row.starts_at, row.ends_at, row.entry_timezone);
      } catch (error) {
        throw new Error(
          `schema v22 contract mismatch: task_fixed_slots row ${row.task_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  const recurring = database
    .prepare(
      `SELECT s.task_id FROM task_fixed_slots s
       JOIN tasks t ON t.id = s.task_id
       WHERE t.recur_every_days IS NOT NULL LIMIT 1`,
    )
    .get() as { task_id: number } | undefined;
  if (recurring) {
    throw new Error(
      `schema v22 contract mismatch: task ${recurring.task_id} has both fixed slot and recurrence`,
    );
  }
}
