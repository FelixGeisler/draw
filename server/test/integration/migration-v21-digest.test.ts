import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../../src/db.js";
import { DEADLINE_REMINDER_CLAIMS_SQL } from "../../src/schemaV20.js";
import { DAILY_DIGEST_CLAIMS_SQL, validateV21Contract } from "../../src/schemaV21.js";
import { stripV22Schema } from "../schemaFixtures.js";

const current = stripV22Schema(
  fs.readFileSync(fileURLToPath(new URL("../../src/schema.sql", import.meta.url)), "utf8"),
);
const v20 = current
  .replace(
    /-- Daily digest once-per-device[\s\S]*?CREATE TABLE daily_digest_claims[\s\S]*?\);\r?\n\r?\n/,
    `${DEADLINE_REMINDER_CLAIMS_SQL};\n\n`,
  )
  .replace("  ('push_hide_details', '0'),", "  ('push_hide_details', '0'),\n  ('push_lead_days', '1'),");

function open(name: string, schema = current, version = 21): Database.Database {
  const database = new Database(path.join(process.env.DATA_DIR!, `${name}.db`));
  database.exec(schema);
  database.pragma(`user_version=${version}`);
  database.pragma("foreign_keys=ON");
  return database;
}

function snapshot(database: Database.Database) {
  return {
    settings: database.prepare("SELECT key,value FROM settings WHERE key LIKE 'push_%' ORDER BY key").all(),
    claimsSql: (database.prepare("SELECT sql FROM sqlite_schema WHERE name='daily_digest_claims'").get() as { sql: string }).sql.replaceAll("\r\n", "\n"),
    columns: database.prepare("PRAGMA table_info(daily_digest_claims)").all(),
    indexes: database.prepare("PRAGMA index_list(daily_digest_claims)").all(),
    foreignKeys: database.prepare("PRAGMA foreign_key_list(daily_digest_claims)").all(),
  };
}

describe("schema v21 atomic digest replacement", () => {
  it("makes fresh and v20→v21 contracts equal while discarding lead and old claims", () => {
    const fresh = new Database(path.join(process.env.DATA_DIR!, "fresh-v21.db"));
    const migrated = open("migrated-v21", v20, 20);
    try {
      migrateDatabase(fresh);
      migrated.prepare(
        `INSERT INTO push_subscriptions VALUES
         ('device','https://push.example','p','a',NULL,'created','seen')`,
      ).run();
      migrated.prepare(
        `INSERT INTO deadline_reminder_claims VALUES
         ('device','task',1,'created','2026-09-20')`,
      ).run();
      migrated.prepare("UPDATE settings SET value='7' WHERE key='push_lead_days'").run();
      migrated.prepare("UPDATE settings SET value='Europe/Berlin' WHERE key='push_timezone'").run();
      migrateDatabase(migrated);

      expect(fresh.pragma("user_version", { simple: true })).toBe(23);
      expect(migrated.pragma("user_version", { simple: true })).toBe(23);
      expect(() => validateV21Contract(fresh)).not.toThrow();
      expect(() => validateV21Contract(migrated)).not.toThrow();
      expect(snapshot(migrated)).toEqual({
        ...snapshot(fresh),
        settings: expect.arrayContaining([
          { key: "push_hide_details", value: "0" },
          { key: "push_quiet_end", value: null },
          { key: "push_quiet_start", value: null },
          { key: "push_send_time", value: "09:00" },
          { key: "push_timezone", value: "Europe/Berlin" },
        ]),
      });
      expect(migrated.prepare("SELECT * FROM daily_digest_claims").all()).toEqual([]);
      expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE name='deadline_reminder_claims'").get()).toBeUndefined();
      expect(migrated.prepare("SELECT key FROM settings WHERE key='push_lead_days'").get()).toBeUndefined();
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("rolls back to a valid stamped v20 contract if target creation fails", () => {
    const database = open("v21-rollback", v20, 20);
    try {
      database.exec("CREATE TABLE daily_digest_claims(collision TEXT)");
      expect(() => migrateDatabase(database)).toThrow(/already exists/);
      expect(database.pragma("user_version", { simple: true })).toBe(20);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name='deadline_reminder_claims'").get()).toBeTruthy();
      expect(database.prepare("SELECT value FROM settings WHERE key='push_lead_days'").get()).toEqual({ value: "1" });
    } finally {
      database.close();
    }
  });

  it.each([
    ["DDL", (database: Database.Database) => {
      database.exec("DROP TABLE daily_digest_claims");
      database.exec(DAILY_DIGEST_CLAIMS_SQL.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"));
    }],
    ["columns", (database: Database.Database) => {
      database.exec("DROP TABLE daily_digest_claims");
      database.exec("CREATE TABLE daily_digest_claims(device_id TEXT,local_date TEXT)");
    }],
    ["index inventory", (database: Database.Database) => {
      database.exec("CREATE INDEX digest_date_idx ON daily_digest_claims(local_date)");
    }],
    ["legacy claims table", (database: Database.Database) => {
      database.exec(DEADLINE_REMINDER_CLAIMS_SQL);
    }],
  ])("rejects malformed v21 %s", (name, mutate) => {
    const database = open(`bad-v21-${String(name).replaceAll(" ", "-")}`);
    try {
      mutate(database);
      expect(() => validateV21Contract(database)).toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts the complete timing domain and rejects lead/nullability drift", () => {
    const database = open("v21-timing");
    const set = database.prepare("UPDATE settings SET value=? WHERE key=?");
    try {
      set.run("23:45", "push_send_time");
      set.run("America/New_York", "push_timezone");
      set.run("22:00", "push_quiet_start");
      set.run("08:00", "push_quiet_end");
      expect(() => validateV21Contract(database)).not.toThrow();
      database.prepare("INSERT INTO settings VALUES ('push_lead_days','1')").run();
      expect(() => validateV21Contract(database)).toThrow(/timing settings/);
      database.prepare("DELETE FROM settings WHERE key='push_lead_days'").run();
      set.run(null, "push_send_time");
      expect(() => validateV21Contract(database)).toThrow(/timing settings/);
    } finally {
      database.close();
    }
  });
});
