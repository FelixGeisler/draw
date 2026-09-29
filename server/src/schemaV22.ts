import type Database from "better-sqlite3";
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

/** Independent complete schema-v22 validator; v21 remains immutable. */
export function validateV22Contract(database: Database.Database): void {
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
  const rows = database
    .prepare(`SELECT task_id, starts_at, ends_at, entry_timezone
              FROM task_fixed_slots WHERE ${timestampGuard}`)
    .all() as Array<{
    task_id: number;
    starts_at: string;
    ends_at: string;
    entry_timezone: string;
  }>;
  for (const row of rows) {
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
