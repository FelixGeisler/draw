import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf8");
const v18Schema = currentSchema
  .replace(/-- Stage 1A Web Push[\s\S]*?CREATE TABLE push_subscriptions[\s\S]*?\);\r?\n\r?\n/, "")
  .replace(/,\r?\n  \('push_hide_details', '0'\)/, "");

const ALTERED_TABLE_CASES: [string, (sql: string) => string, RegExp][] = [
  [
    "altered endpoint collation",
    (sql) =>
      sql.replace(
        "endpoint TEXT NOT NULL UNIQUE",
        "endpoint TEXT COLLATE NOCASE NOT NULL UNIQUE",
      ),
    /push_subscriptions DDL/,
  ],
  [
    "altered unique conflict policy",
    (sql) =>
      sql.replace(
        "endpoint TEXT NOT NULL UNIQUE",
        "endpoint TEXT NOT NULL UNIQUE ON CONFLICT REPLACE",
      ),
    /push_subscriptions DDL/,
  ],
  [
    "unexpected foreign key",
    (sql) =>
      sql.replace(
        "last_seen_at TEXT NOT NULL\n  )",
        "last_seen_at TEXT NOT NULL,\n    FOREIGN KEY (expiration_time) REFERENCES tasks(id)\n  )",
      ),
    /push_subscriptions DDL/,
  ],
];

describe("schema v19 Push persistence", () => {
  it("atomically migrates a real v18 shape without inferring devices", async () => {
    expect(v18Schema).not.toContain("push_subscriptions");
    expect(v18Schema).not.toContain("push_hide_details");
    const file = path.join(process.env.DATA_DIR!, "v18-push.db");
    const legacy = new Database(file);
    legacy.exec(v18Schema);
    legacy.pragma("user_version = 18");
    legacy.close();

    const handle = new Database(file);
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      migrateDatabase(handle);
      expect(handle.pragma("user_version", { simple: true })).toBe(19);
      expect(() => validateV19Contract(handle)).not.toThrow();
      expect(handle.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
      expect(handle.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get()).toEqual({
        value: "0",
      });
      const deferred = handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deadline_reminder_claims'")
        .get();
      expect(deferred).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it("leaves v18 intact if any v19 DDL fails", async () => {
    const file = path.join(process.env.DATA_DIR!, "v18-push-failure.db");
    const handle = new Database(file);
    try {
      handle.exec(v18Schema);
      handle.exec("CREATE TABLE push_subscriptions (collision TEXT)");
      handle.pragma("user_version = 18");
      const { migrateDatabase } = await import("../../src/db.js");
      expect(() => migrateDatabase(handle)).toThrow(/already exists/);
      expect(handle.pragma("user_version", { simple: true })).toBe(18);
      expect(handle.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get()).toBeUndefined();
      expect(
        (handle.prepare("PRAGMA table_info(push_subscriptions)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      ).toEqual(["collision"]);
    } finally {
      handle.close();
    }
  });

  it("rejects unapproved persistent triggers and indirect view paths", async () => {
    const file = path.join(process.env.DATA_DIR!, "v19-persistent-code.db");
    const handle = new Database(file);
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      migrateDatabase(handle);

      handle.exec(`CREATE VIEW push_credentials_view AS
        SELECT endpoint, p256dh, auth FROM push_subscriptions`);
      expect(() => validateV19Contract(handle)).toThrow(/unapproved persistent view/);
      handle.exec("DROP VIEW push_credentials_view");

      // SQL LIKE treats `_` as a wildcard, so this ordinary name matched the
      // former `NOT LIKE 'sqlite_%'` exclusion despite not being SQLite-owned.
      handle.exec(`CREATE TRIGGER sqlitexfiltrate
        BEFORE DELETE ON push_subscriptions BEGIN
          INSERT OR REPLACE INTO settings (key, value)
          VALUES ('crafted_push_leak', OLD.endpoint || OLD.p256dh || OLD.auth);
        END`);
      expect(() => validateV19Contract(handle)).toThrow(/persistent trigger sqlitexfiltrate/);
    } finally {
      handle.close();
    }
  });

  it.each(ALTERED_TABLE_CASES)(
    "rejects %s instead of accepting a column-compatible v19 table",
    async (_name, alter, error) => {
      const file = path.join(
        process.env.DATA_DIR!,
        `v19-altered-${_name.replaceAll(" ", "-")}.db`,
      );
      const handle = new Database(file);
      try {
        const { migrateDatabase } = await import("../../src/db.js");
        const { validateV19Contract, V19_STATEMENTS } = await import("../../src/schemaV19.js");
        migrateDatabase(handle);
        handle.exec("DROP TABLE push_subscriptions");
        handle.exec(alter(V19_STATEMENTS[0]));
        expect(() => validateV19Contract(handle)).toThrow(error);
      } finally {
        handle.close();
      }
    },
  );

  it("rejects an extra v19 index outside the canonical constraint inventory", async () => {
    const file = path.join(process.env.DATA_DIR!, "v19-extra-index.db");
    const handle = new Database(file);
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      migrateDatabase(handle);
      handle.exec("CREATE INDEX push_subscriptions_last_seen ON push_subscriptions(last_seen_at)");
      expect(() => validateV19Contract(handle)).toThrow(/push_subscriptions index inventory/);
    } finally {
      handle.close();
    }
  });

  it("fresh schema matches the same exact contract", async () => {
    const file = path.join(process.env.DATA_DIR!, "fresh-v19.db");
    const handle = new Database(file);
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      migrateDatabase(handle);
      expect(handle.pragma("user_version", { simple: true })).toBe(19);
      expect(() => validateV19Contract(handle)).not.toThrow();
    } finally {
      handle.close();
    }
  });
});
