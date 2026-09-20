import type Database from "better-sqlite3";
import { schemaSqlTokens } from "./schemaV18.js";
import { validateV19InheritedContract } from "./schemaV19.js";

/** Exact schema-v20 objects approved by #345. */
export const V20_SETTINGS_SQL = "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)";
export const DEADLINE_REMINDER_CLAIMS_SQL = `CREATE TABLE deadline_reminder_claims (
  device_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('task', 'goal')),
  item_id INTEGER NOT NULL,
  item_created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  PRIMARY KEY (device_id, item_type, item_id, item_created_at, deadline)
)`;

export const V20_TIMING_DEFAULTS = [
  ["push_lead_days", "1"],
  ["push_send_time", "09:00"],
  ["push_timezone", null],
  ["push_quiet_start", null],
  ["push_quiet_end", null],
] as const;

const EXPECTED_SETTINGS_COLUMNS = [
  ["key", "TEXT", 0, null, 1],
  ["value", "TEXT", 0, null, 0],
] as const;

const EXPECTED_CLAIMS_COLUMNS = [
  ["device_id", "TEXT", 1, null, 1],
  ["item_type", "TEXT", 1, null, 2],
  ["item_id", "INTEGER", 1, null, 3],
  ["item_created_at", "TEXT", 1, null, 4],
  ["deadline", "TEXT", 1, null, 5],
] as const;

const EXPECTED_SETTINGS_INDEX = [
  {
    unique: 1,
    origin: "pk",
    partial: 0,
    columns: [
      [0, 0, "key", 0, "BINARY", 1],
      [1, -1, null, 0, "BINARY", 0],
    ],
  },
] as const;

const EXPECTED_CLAIMS_INDEX = [
  {
    unique: 1,
    origin: "pk",
    partial: 0,
    columns: [
      [0, 0, "device_id", 0, "BINARY", 1],
      [1, 1, "item_type", 0, "BINARY", 1],
      [2, 2, "item_id", 0, "BINARY", 1],
      [3, 3, "item_created_at", 0, "BINARY", 1],
      [4, 4, "deadline", 0, "BINARY", 1],
      [5, -1, null, 0, "BINARY", 0],
    ],
  },
] as const;

const EXPECTED_CLAIMS_FOREIGN_KEYS = [
  [0, 0, "push_subscriptions", "device_id", "id", "NO ACTION", "CASCADE", "NONE"],
] as const;

function objectSql(database: Database.Database, name: string): string | undefined {
  return (
    database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name) as { sql: string } | undefined
  )?.sql;
}

function requireExactTable(database: Database.Database, name: string, expected: string): void {
  const actual = objectSql(database, name);
  if (
    !actual ||
    schemaSqlTokens(actual).join("\0") !== schemaSqlTokens(expected).join("\0")
  ) {
    throw new Error(`schema v20 contract mismatch: ${name} DDL`);
  }
}

function tableColumns(database: Database.Database, table: string): unknown[][] {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  return columns.map((column) => [
    column.name,
    column.type.toUpperCase(),
    column.notnull,
    column.dflt_value,
    column.pk,
  ]);
}

function indexInventory(database: Database.Database, table: string): unknown[] {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  return indexes
    .map((index) => ({
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: (
        database.prepare(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`).all() as {
          seqno: number;
          cid: number;
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }[]
      ).map((column) => [
        column.seqno,
        column.cid,
        column.name,
        column.desc,
        column.coll,
        column.key,
      ]),
    }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
}

function foreignKeyInventory(database: Database.Database, table: string): unknown[][] {
  return (
    database.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }[]
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

function isQuarterHour(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value);
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  // ASCII code units are one byte in UTF-8, so this simultaneously enforces
  // the approved byte bound and rejects Unicode aliases/lookalikes.
  if ([...value].some((character) => character.charCodeAt(0) > 0x7f)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validateTimingSettings(database: Database.Database): void {
  const rows = database
    .prepare(
      `SELECT key, value FROM settings
       WHERE key IN ('push_lead_days', 'push_send_time', 'push_timezone',
                     'push_quiet_start', 'push_quiet_end')`,
    )
    .all() as { key: string; value: string | null }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  if (values.size !== V20_TIMING_DEFAULTS.length) {
    throw new Error("schema v20 contract mismatch: missing timing setting");
  }

  const lead = values.get("push_lead_days");
  if (!new Set(["0", "1", "2", "3", "7", "14", "30"]).has(lead as string)) {
    throw new Error("schema v20 contract mismatch: push_lead_days");
  }
  if (!isQuarterHour(values.get("push_send_time"))) {
    throw new Error("schema v20 contract mismatch: push_send_time");
  }

  const timezone = values.get("push_timezone");
  if (timezone !== null && !isTimeZone(timezone)) {
    throw new Error("schema v20 contract mismatch: push_timezone");
  }

  const quietStart = values.get("push_quiet_start");
  const quietEnd = values.get("push_quiet_end");
  const quietOff = quietStart === null && quietEnd === null;
  const quietOn =
    isQuarterHour(quietStart) && isQuarterHour(quietEnd) && quietStart !== quietEnd;
  if (!quietOff && !quietOn) {
    throw new Error("schema v20 contract mismatch: quiet hours");
  }

  const unexpectedNull = database
    .prepare(
      `SELECT key FROM settings
       WHERE value IS NULL
         AND key NOT IN ('push_timezone', 'push_quiet_start', 'push_quiet_end')
       LIMIT 1`,
    )
    .get() as { key: string } | undefined;
  if (unexpectedNull) {
    throw new Error(`schema v20 contract mismatch: null setting ${unexpectedNull.key}`);
  }
}

/** Validate the complete runtime schema-v20 contract. */
export function validateV20Contract(database: Database.Database): void {
  // Push structure, Hide-details, and the complete trigger/view inventory stay
  // inherited from v19. Only the settings nullability is version-specific.
  validateV19InheritedContract(database);

  requireExactTable(database, "settings", V20_SETTINGS_SQL);
  if (JSON.stringify(tableColumns(database, "settings")) !== JSON.stringify(EXPECTED_SETTINGS_COLUMNS)) {
    throw new Error("schema v20 contract mismatch: settings columns");
  }
  if (JSON.stringify(indexInventory(database, "settings")) !== JSON.stringify(EXPECTED_SETTINGS_INDEX)) {
    throw new Error("schema v20 contract mismatch: settings index inventory");
  }
  if (foreignKeyInventory(database, "settings").length !== 0) {
    throw new Error("schema v20 contract mismatch: settings foreign keys");
  }

  requireExactTable(database, "deadline_reminder_claims", DEADLINE_REMINDER_CLAIMS_SQL);
  if (
    JSON.stringify(tableColumns(database, "deadline_reminder_claims")) !==
    JSON.stringify(EXPECTED_CLAIMS_COLUMNS)
  ) {
    throw new Error("schema v20 contract mismatch: deadline_reminder_claims columns");
  }
  if (
    JSON.stringify(indexInventory(database, "deadline_reminder_claims")) !==
    JSON.stringify(EXPECTED_CLAIMS_INDEX)
  ) {
    throw new Error("schema v20 contract mismatch: deadline_reminder_claims index inventory");
  }
  if (
    JSON.stringify(foreignKeyInventory(database, "deadline_reminder_claims")) !==
    JSON.stringify(EXPECTED_CLAIMS_FOREIGN_KEYS)
  ) {
    throw new Error("schema v20 contract mismatch: deadline_reminder_claims foreign keys");
  }

  validateTimingSettings(database);
}
