import type Database from "better-sqlite3";
import { schemaSqlTokens, V18_STATEMENTS } from "./schemaV18.js";

/** Exact schema-v19 additions approved by #337. */
export const V19_STATEMENTS = [
  `CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    expiration_time INTEGER NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `INSERT INTO settings (key, value) VALUES ('push_hide_details', '0')`,
] as const;

const EXPECTED_PERSISTENT_SCHEMA_CODE = new Map(
  [
    `CREATE TRIGGER tasks_stamp_sort_order AFTER INSERT ON tasks
      WHEN NEW.sort_order = 0
      BEGIN
        UPDATE tasks SET sort_order =
          (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks WHERE id != NEW.id)
        WHERE id = NEW.id;
      END`,
    ...V18_STATEMENTS.filter((sql) => /^CREATE TRIGGER /.test(sql)),
  ].map((sql) => {
    const name = /^CREATE TRIGGER\s+([^\s]+)/i.exec(sql)![1];
    return [name, sql] as const;
  }),
);

const EXPECTED_COLUMNS = [
  ["id", "TEXT", 0, null, 1],
  ["endpoint", "TEXT", 1, null, 0],
  ["p256dh", "TEXT", 1, null, 0],
  ["auth", "TEXT", 1, null, 0],
  ["expiration_time", "INTEGER", 0, null, 0],
  ["created_at", "TEXT", 1, null, 0],
  ["last_seen_at", "TEXT", 1, null, 0],
] as const;

const PUSH_SUBSCRIPTIONS_SQL = V19_STATEMENTS.find((sql) =>
  /^CREATE TABLE push_subscriptions\b/.test(sql),
)!;

const EXPECTED_INDEX_INVENTORY = [
  {
    unique: 1,
    origin: "pk",
    partial: 0,
    columns: [
      [0, 0, "id", 0, "BINARY", 1],
      [1, -1, null, 0, "BINARY", 0],
    ],
  },
  {
    unique: 1,
    origin: "u",
    partial: 0,
    columns: [
      [0, 1, "endpoint", 0, "BINARY", 1],
      [1, -1, null, 0, "BINARY", 0],
    ],
  },
] as const;

function objectSql(database: Database.Database, type: "table", name: string): string | undefined {
  return (
    database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?")
      .get(type, name) as { sql: string } | undefined
  )?.sql;
}

function validatePushSubscriptionStructure(database: Database.Database): void {
  const tableSql = objectSql(database, "table", "push_subscriptions");
  if (
    !tableSql ||
    schemaSqlTokens(tableSql).join("\0") !== schemaSqlTokens(PUSH_SUBSCRIPTIONS_SQL).join("\0")
  ) {
    throw new Error("schema v19 contract mismatch: push_subscriptions DDL");
  }

  const indexes = database.prepare("PRAGMA index_list(push_subscriptions)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const inventory = indexes
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
  if (JSON.stringify(inventory) !== JSON.stringify(EXPECTED_INDEX_INVENTORY)) {
    throw new Error("schema v19 contract mismatch: push_subscriptions index inventory");
  }

  const foreignKeys = database.prepare("PRAGMA foreign_key_list(push_subscriptions)").all();
  if (foreignKeys.length !== 0) {
    throw new Error("schema v19 contract mismatch: push_subscriptions foreign keys");
  }
}

/**
 * Reject executable persistent schema objects other than Draw's exact shipped
 * triggers. Import scrubbing performs DELETEs, so this gate must run before a
 * crafted trigger or an indirect view path can copy credential columns into
 * retained application data.
 */
function validatePersistentSchemaCode(database: Database.Database): void {
  const objects = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE type IN ('trigger', 'view')
       ORDER BY type, name`,
    )
    .all() as { type: "trigger" | "view"; name: string; sql: string | null }[];
  if (objects.some((object) => object.type === "view")) {
    throw new Error("schema v19 contract mismatch: unapproved persistent view");
  }
  for (const object of objects) {
    const expected = EXPECTED_PERSISTENT_SCHEMA_CODE.get(object.name);
    if (
      !expected ||
      !object.sql ||
      schemaSqlTokens(object.sql).join("\0") !== schemaSqlTokens(expected).join("\0")
    ) {
      throw new Error(`schema v19 contract mismatch: persistent trigger ${object.name}`);
    }
  }
  if (objects.length !== EXPECTED_PERSISTENT_SCHEMA_CODE.size) {
    throw new Error("schema v19 contract mismatch: missing persistent trigger");
  }
}

/** Reject a stamped v19 database whose table/default/code is incomplete or weakened. */
export function validateV19Contract(database: Database.Database): void {
  validatePersistentSchemaCode(database);
  validatePushSubscriptionStructure(database);
  const columns = database.prepare("PRAGMA table_info(push_subscriptions)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const actual = columns.map((column) => [
    column.name,
    column.type.toUpperCase(),
    column.notnull,
    column.dflt_value,
    column.pk,
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_COLUMNS)) {
    throw new Error("schema v19 contract mismatch: push_subscriptions columns");
  }

  const setting = database
    .prepare("SELECT value FROM settings WHERE key = 'push_hide_details'")
    .get() as { value: string } | undefined;
  // The migration/fresh default is 0; a later preference write may
  // legitimately persist 1, so restore validation proves the closed boolean
  // domain rather than resetting user state.
  if (setting?.value !== "0" && setting?.value !== "1") {
    throw new Error("schema v19 contract mismatch: push_hide_details");
  }
}
