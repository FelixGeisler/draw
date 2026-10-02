import type Database from "better-sqlite3";
import { schemaSqlTokens } from "./schemaV18.js";
import {
  WEEK_MAX_SAFE_ID,
  WEEK_PROJECTION_BATCH_SIZE,
  buildWeekProjection,
  createWeekSchema,
  dropWeekSchema,
  parseWeekTimestamp,
  validateV23Projection,
  validateV23Structure,
  type WeekProjectionScanHooks,
} from "./schemaV23.js";

export const TIME_ENTRIES_V24_SQL = `CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (
    (ended_at IS NULL AND end_reason IS NULL) OR
    (ended_at IS NOT NULL AND (end_reason IS NULL OR end_reason IN ('done', 'stop')))
  )
)`;

export const V24_END_REASON_COLUMN_SQL = `ALTER TABLE time_entries
  ADD COLUMN end_reason TEXT CHECK (
    (ended_at IS NULL AND end_reason IS NULL) OR
    (ended_at IS NOT NULL AND (end_reason IS NULL OR end_reason IN ('done', 'stop')))
  )`;

export const V24_FOREST_INDEX_SQL =
  "CREATE INDEX idx_time_entries_forest ON time_entries(id DESC) WHERE end_reason IS NOT NULL";

function exactSql(
  database: Database.Database,
  type: "table" | "index",
  name: string,
  expected: string,
): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?")
    .get(type, name) as { sql: string | null } | undefined;
  if (!row?.sql || schemaSqlTokens(row.sql).join("\0") !== schemaSqlTokens(expected).join("\0")) {
    throw new Error(`schema v24 contract mismatch: ${name} DDL`);
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`schema v24 contract mismatch: ${label}`);
  }
}

export type ForestValidationHooks = Readonly<{
  batch?: (batch: Readonly<{ rowCount: number }>) => void;
}>;

export function validateV24Structure(
  database: Database.Database,
  requireVersion = true,
  weekHooks: WeekProjectionScanHooks = {},
): void {
  validateV23Structure(database, false, weekHooks, true);
  if (requireVersion && database.pragma("user_version", { simple: true }) !== 24) {
    throw new Error("schema v24 contract mismatch: user_version");
  }
  exactSql(database, "table", "time_entries", TIME_ENTRIES_V24_SQL);
  exactSql(database, "index", "idx_time_entries_forest", V24_FOREST_INDEX_SQL);

  const columns = database.prepare("PRAGMA table_info(time_entries)").all() as Array<
    Record<string, unknown>
  >;
  equal(
    "time_entries columns",
    columns.map((row) => [row.name, String(row.type).toUpperCase(), row.notnull, row.dflt_value, row.pk]),
    [
      ["id", "INTEGER", 0, null, 1],
      ["task_id", "INTEGER", 1, null, 0],
      ["started_at", "TEXT", 1, null, 0],
      ["ended_at", "TEXT", 0, null, 0],
      ["end_reason", "TEXT", 0, null, 0],
    ],
  );
  const index = database.prepare("PRAGMA index_list(time_entries)").all() as Array<
    Record<string, unknown>
  >;
  const forest = index.find((row) => row.name === "idx_time_entries_forest");
  equal(
    "forest index",
    forest && [forest.unique, forest.origin, forest.partial],
    [0, "c", 1],
  );
  const xinfo = database.prepare("PRAGMA index_xinfo(idx_time_entries_forest)").all() as Array<
    Record<string, unknown>
  >;
  equal(
    "forest index order",
    xinfo.map((row) => [row.seqno, row.cid, row.name, row.desc, row.coll, row.key]),
    [
      [0, 0, "id", 1, "BINARY", 1],
      [1, -1, null, 0, "BINARY", 0],
    ],
  );
}

export function validateV24ClassifiedRows(
  database: Database.Database,
  hooks: ForestValidationHooks = {},
): void {
  const malformed = database.prepare(`SELECT 1 FROM time_entries
    WHERE end_reason IS NOT NULL AND NOT (
      typeof(id)='integer' AND id BETWEEN 1 AND 9007199254740991
      AND typeof(end_reason)='text' AND end_reason IN ('done','stop')
      AND ended_at IS NOT NULL
      AND CASE WHEN typeof(started_at)='text'
               THEN CASE WHEN octet_length(started_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
      AND CASE WHEN typeof(ended_at)='text'
               THEN CASE WHEN octet_length(ended_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
    ) LIMIT 1`).get();
  if (malformed) throw new Error("schema v24 contract mismatch: classified row storage domain");

  const statement = database.prepare(`SELECT id,started_at AS startedAt,ended_at AS endedAt,
      end_reason AS endReason
    FROM time_entries
    WHERE end_reason IS NOT NULL AND id>?
    ORDER BY id LIMIT ?`);
  let after = 0;
  for (;;) {
    const rows = statement.all(after, WEEK_PROJECTION_BATCH_SIZE) as Array<{
      id: number;
      startedAt: string;
      endedAt: string;
      endReason: string;
    }>;
    if (rows.length === 0) break;
    hooks.batch?.(Object.freeze({ rowCount: rows.length }));
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id < 1 || row.id > WEEK_MAX_SAFE_ID) {
        throw new Error("schema v24 contract mismatch: classified row id");
      }
      after = row.id;
      const start = parseWeekTimestamp(row.startedAt, "forest start");
      const end = parseWeekTimestamp(row.endedAt, "forest end");
      if (start === null || end === null || end < start || !["done", "stop"].includes(row.endReason)) {
        throw new Error(`schema v24 contract mismatch: classified row ${row.id}`);
      }
    }
  }
}

export function validateV24Contract(
  database: Database.Database,
  options: Readonly<{
    requireVersion?: boolean;
    weekHooks?: WeekProjectionScanHooks;
    forestHooks?: ForestValidationHooks;
  }> = {},
): void {
  validateV24Structure(database, options.requireVersion ?? true, options.weekHooks);
  validateV24ClassifiedRows(database, options.forestHooks);
  validateV23Projection(database, false, options.weekHooks);
}

/** Rebuild only the disposable Week projection after exact v24 source admission. */
export function resetImportedV24Projection(database: Database.Database): void {
  validateV24Structure(database);
  validateV24ClassifiedRows(database);
  database.transaction(() => {
    dropWeekSchema(database);
    createWeekSchema(database);
    buildWeekProjection(database);
    validateV24Structure(database);
    validateV23Projection(database, true);
    database.prepare(
      "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
    ).run();
    validateV24Contract(database);
  })();
}
