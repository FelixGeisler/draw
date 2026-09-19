import type Database from "better-sqlite3";

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

const EXPECTED_COLUMNS = [
  ["id", "TEXT", 0, null, 1],
  ["endpoint", "TEXT", 1, null, 0],
  ["p256dh", "TEXT", 1, null, 0],
  ["auth", "TEXT", 1, null, 0],
  ["expiration_time", "INTEGER", 0, null, 0],
  ["created_at", "TEXT", 1, null, 0],
  ["last_seen_at", "TEXT", 1, null, 0],
] as const;

/** Reject a stamped v19 database whose table/default is incomplete or weakened. */
export function validateV19Contract(database: Database.Database): void {
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

  const indexes = database.prepare("PRAGMA index_list(push_subscriptions)").all() as {
    name: string;
    unique: number;
    origin: string;
  }[];
  const endpointUnique = indexes.some((index) => {
    if (index.unique !== 1 || index.origin !== "u") return false;
    const indexed = database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as {
      name: string;
    }[];
    return indexed.length === 1 && indexed[0].name === "endpoint";
  });
  if (!endpointUnique) {
    throw new Error("schema v19 contract mismatch: endpoint UNIQUE");
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
