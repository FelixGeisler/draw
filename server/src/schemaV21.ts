import type Database from "better-sqlite3";
import { schemaSqlTokens } from "./schemaV18.js";
import { validateV19InheritedContract } from "./schemaV19.js";

export const V21_SETTINGS_SQL = "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)";
export const DAILY_DIGEST_CLAIMS_SQL = `CREATE TABLE daily_digest_claims (
  device_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  PRIMARY KEY (device_id, local_date)
)`;

function tableSql(database: Database.Database, name: string): string | undefined {
  return (database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
    .get(name) as { sql: string } | undefined)?.sql;
}

function exactTable(database: Database.Database, name: string, expected: string): void {
  const actual = tableSql(database, name);
  if (!actual || schemaSqlTokens(actual).join("\0") !== schemaSqlTokens(expected).join("\0")) {
    throw new Error(`schema v21 contract mismatch: ${name} DDL`);
  }
}

function columns(database: Database.Database, table: string): unknown[][] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>).map((column) => [column.name, column.type.toUpperCase(), column.notnull, column.dflt_value, column.pk]);
}

function indexes(database: Database.Database, table: string): unknown[] {
  return (database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>).map((index) => ({
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: (database.prepare(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`).all() as Array<{
      seqno: number; cid: number; name: string | null; desc: number; coll: string; key: number;
    }>).map((column) => [column.seqno, column.cid, column.name, column.desc, column.coll, column.key]),
  })).sort((left, right) => left.origin.localeCompare(right.origin));
}

function foreignKeys(database: Database.Database, table: string): unknown[][] {
  return (database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number; seq: number; table: string; from: string; to: string;
    on_update: string; on_delete: string; match: string;
  }>).map((key) => [key.id, key.seq, key.table, key.from, key.to, key.on_update, key.on_delete, key.match]);
}

function quarter(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value);
}

function timezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
    [...value].some((character) => character.charCodeAt(0) > 0x7f)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; } catch { return false; }
}

/** Independent exact validator for the complete schema-v21 Push contract. */
export function validateV21Contract(database: Database.Database): void {
  validateV19InheritedContract(database);
  exactTable(database, "settings", V21_SETTINGS_SQL);
  exactTable(database, "daily_digest_claims", DAILY_DIGEST_CLAIMS_SQL);
  if (tableSql(database, "deadline_reminder_claims")) throw new Error("schema v21 contract mismatch: legacy claims table");

  const expectedSettingsColumns = [["key", "TEXT", 0, null, 1], ["value", "TEXT", 0, null, 0]];
  const expectedClaimColumns = [["device_id", "TEXT", 1, null, 1], ["local_date", "TEXT", 1, null, 2]];
  if (JSON.stringify(columns(database, "settings")) !== JSON.stringify(expectedSettingsColumns)) {
    throw new Error("schema v21 contract mismatch: settings columns");
  }
  if (JSON.stringify(columns(database, "daily_digest_claims")) !== JSON.stringify(expectedClaimColumns)) {
    throw new Error("schema v21 contract mismatch: daily_digest_claims columns");
  }
  const settingsIndex = [{ unique: 1, origin: "pk", partial: 0, columns: [[0, 0, "key", 0, "BINARY", 1], [1, -1, null, 0, "BINARY", 0]] }];
  const claimIndex = [{ unique: 1, origin: "pk", partial: 0, columns: [[0, 0, "device_id", 0, "BINARY", 1], [1, 1, "local_date", 0, "BINARY", 1], [2, -1, null, 0, "BINARY", 0]] }];
  if (JSON.stringify(indexes(database, "settings")) !== JSON.stringify(settingsIndex) ||
    JSON.stringify(indexes(database, "daily_digest_claims")) !== JSON.stringify(claimIndex)) {
    throw new Error("schema v21 contract mismatch: index inventory");
  }
  if (foreignKeys(database, "settings").length !== 0 || JSON.stringify(foreignKeys(database, "daily_digest_claims")) !==
    JSON.stringify([[0, 0, "push_subscriptions", "device_id", "id", "NO ACTION", "CASCADE", "NONE"]])) {
    throw new Error("schema v21 contract mismatch: foreign key inventory");
  }

  const rows = database.prepare(
    `SELECT key,value FROM settings WHERE key IN
     ('push_send_time','push_timezone','push_quiet_start','push_quiet_end','push_lead_days')`,
  ).all() as { key: string; value: string | null }[];
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  if (values.has("push_lead_days") || !quarter(values.get("push_send_time"))) {
    throw new Error("schema v21 contract mismatch: timing settings");
  }
  const zone = values.get("push_timezone");
  if (zone !== null && !timezone(zone)) throw new Error("schema v21 contract mismatch: push_timezone");
  const quietStart = values.get("push_quiet_start");
  const quietEnd = values.get("push_quiet_end");
  if (!(quietStart === null && quietEnd === null) &&
    !(quarter(quietStart) && quarter(quietEnd) && quietStart !== quietEnd)) {
    throw new Error("schema v21 contract mismatch: quiet hours");
  }
  if (["push_send_time", "push_timezone", "push_quiet_start", "push_quiet_end"].some((key) => !values.has(key))) {
    throw new Error("schema v21 contract mismatch: missing timing setting");
  }
  const unexpectedNull = database.prepare(
    `SELECT key FROM settings WHERE value IS NULL
     AND key NOT IN ('push_timezone','push_quiet_start','push_quiet_end') LIMIT 1`,
  ).get();
  if (unexpectedNull) throw new Error("schema v21 contract mismatch: unexpected null setting");
}
