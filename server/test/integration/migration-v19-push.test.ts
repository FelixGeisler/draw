import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf8");
const v19Schema = currentSchema
  .replace(
    /-- Stage 2A deadline-reminder[\s\S]*?CREATE TABLE deadline_reminder_claims[\s\S]*?\);\r?\n\r?\n/,
    "",
  )
  .replace(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  )
  .replace(
    /,\r?\n  \('push_lead_days', '1'\)[\s\S]*?\('push_quiet_end', NULL\)/,
    "",
  );
const v18Schema = v19Schema
  .replace(/-- Stage 1A Web Push[\s\S]*?CREATE TABLE push_subscriptions[\s\S]*?\);\r?\n\r?\n/, "")
  .replace(/,\r?\n  \('push_hide_details', '0'\)/, "");

const ALTERED_TABLE_CASES: [string, (sql: string) => string, RegExp][] = [
  [
    "altered endpoint collation",
    (sql) => sql.replace("endpoint TEXT NOT NULL UNIQUE", "endpoint TEXT COLLATE NOCASE NOT NULL UNIQUE"),
    /push_subscriptions DDL/,
  ],
  [
    "altered unique conflict policy",
    (sql) => sql.replace("endpoint TEXT NOT NULL UNIQUE", "endpoint TEXT NOT NULL UNIQUE ON CONFLICT REPLACE"),
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

function openV19(name: string): Database.Database {
  const file = path.join(process.env.DATA_DIR!, `${name}.db`);
  const handle = new Database(file);
  handle.exec(v19Schema);
  handle.pragma("user_version = 19");
  return handle;
}

describe("schema v19 Push persistence remains an exact migration boundary", () => {
  it("validates a canonical v19 fixture, then migrates it to v20", async () => {
    expect(v19Schema).not.toContain("deadline_reminder_claims");
    const handle = openV19("canonical-v19");
    try {
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      const { validateV20Contract } = await import("../../src/schemaV20.js");
      expect(() => validateV19Contract(handle)).not.toThrow();
      migrateDatabase(handle);
      expect(handle.pragma("user_version", { simple: true })).toBe(20);
      expect(() => validateV20Contract(handle)).not.toThrow();
    } finally {
      handle.close();
    }
  });

  it("keeps the independent v19 transaction stamped 19 when v20 fails", async () => {
    const file = path.join(process.env.DATA_DIR!, "v18-to-v19-v20-failure.db");
    const handle = new Database(file);
    try {
      handle.exec(v18Schema);
      // Valid ordinary v18/v19 setting, but an approved v20 default collision.
      handle.prepare("INSERT INTO settings (key, value) VALUES ('push_lead_days', '7')").run();
      handle.pragma("user_version = 18");
      const { migrateDatabase } = await import("../../src/db.js");
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      expect(() => migrateDatabase(handle)).toThrow(/UNIQUE/);
      expect(handle.pragma("user_version", { simple: true })).toBe(19);
      expect(() => validateV19Contract(handle)).not.toThrow();
      expect(
        handle.prepare("SELECT name FROM sqlite_schema WHERE name = 'deadline_reminder_claims'").get(),
      ).toBeUndefined();
      expect(handle.prepare("SELECT value FROM settings WHERE key = 'push_lead_days'").get()).toEqual({
        value: "7",
      });
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
    } finally {
      handle.close();
    }
  });

  it("rejects unapproved persistent triggers and indirect view paths without LIKE wildcards", async () => {
    const handle = openV19("v19-persistent-code");
    try {
      const { validateV19Contract } = await import("../../src/schemaV19.js");
      handle.exec("CREATE TABLE legacy_extension (value TEXT)");
      expect(() => validateV19Contract(handle)).not.toThrow();

      handle.exec("CREATE VIEW push_credentials_view AS SELECT endpoint, p256dh, auth FROM push_subscriptions");
      expect(() => validateV19Contract(handle)).toThrow(/unapproved persistent view/);
      handle.exec("DROP VIEW push_credentials_view");

      // `_` is a LIKE wildcard, but this exact inventory cannot be bypassed by
      // a trigger whose ordinary name starts with sqlite-like characters.
      handle.exec(`CREATE TRIGGER sqlitexfiltrate
        BEFORE DELETE ON legacy_extension BEGIN
          INSERT OR REPLACE INTO settings (key, value) VALUES ('crafted_push_leak', OLD.value);
        END`);
      expect(() => validateV19Contract(handle)).toThrow(/persistent trigger sqlitexfiltrate/);
    } finally {
      handle.close();
    }
  });

  it.each(ALTERED_TABLE_CASES)("rejects %s", async (_name, alter, error) => {
    const handle = openV19(`v19-altered-${_name.replaceAll(" ", "-")}`);
    try {
      const { validateV19Contract, V19_STATEMENTS } = await import("../../src/schemaV19.js");
      handle.exec("DROP TABLE push_subscriptions");
      handle.exec(alter(V19_STATEMENTS[0]));
      expect(() => validateV19Contract(handle)).toThrow(error);
    } finally {
      handle.close();
    }
  });

  it("rejects settings DDL/index/FK deviations and null ordinary values", async () => {
    const { validateV19Contract } = await import("../../src/schemaV19.js");

    const extraIndex = openV19("v19-settings-extra-index");
    try {
      extraIndex.exec("CREATE INDEX settings_value_idx ON settings(value)");
      expect(() => validateV19Contract(extraIndex)).toThrow(/settings index inventory/);
    } finally {
      extraIndex.close();
    }

    const nullable = openV19("v19-settings-nullable");
    try {
      nullable.exec("ALTER TABLE settings RENAME TO old_settings");
      nullable.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      nullable.exec("INSERT INTO settings SELECT * FROM old_settings; DROP TABLE old_settings");
      expect(() => validateV19Contract(nullable)).toThrow(/settings DDL/);
    } finally {
      nullable.close();
    }
  });
});
