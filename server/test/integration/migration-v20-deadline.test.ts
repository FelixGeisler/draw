import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEADLINE_REMINDER_CLAIMS_SQL, validateV20Contract } from "../../src/schemaV20.js";

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

function file(name: string): string {
  return path.join(process.env.DATA_DIR!, `${name}.db`);
}

function canonicalV20(name: string): Database.Database {
  const database = new Database(file(name));
  database.exec(currentSchema);
  database.pragma("user_version = 20");
  return database;
}

function contractSnapshot(database: Database.Database) {
  const table = (name: string) => ({
    sql: (database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql.replaceAll("\r\n", "\n"),
    columns: database.prepare(`PRAGMA table_info(${name})`).all(),
    indexes: (database.prepare(`PRAGMA index_list(${name})`).all() as { name: string }[]).map((index) => ({
      row: index,
      columns: database.prepare(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`).all(),
    })),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${name})`).all(),
  });
  return {
    settings: table("settings"),
    claims: table("deadline_reminder_claims"),
    timing: database
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'push_%' ORDER BY key")
      .all(),
  };
}

describe("schema v20 deadline foundation", () => {
  it("makes fresh and real v19→v20 databases contract-equal while preserving ordinary settings", async () => {
    const { migrateDatabase } = await import("../../src/db.js");
    const fresh = new Database(file("fresh-v20"));
    const migrated = new Database(file("migrated-v20"));
    try {
      migrateDatabase(fresh);
      migrated.exec(v19Schema);
      migrated.prepare("INSERT INTO settings (key, value) VALUES ('ordinary_fixture', 'byte-for-byte')").run();
      migrated.prepare("UPDATE settings SET value = '1' WHERE key = 'push_hide_details'").run();
      migrated.pragma("user_version = 19");
      migrateDatabase(migrated);

      expect(fresh.pragma("user_version", { simple: true })).toBe(20);
      expect(migrated.pragma("user_version", { simple: true })).toBe(20);
      expect(() => validateV20Contract(fresh)).not.toThrow();
      expect(() => validateV20Contract(migrated)).not.toThrow();

      const freshContract = contractSnapshot(fresh);
      const migratedContract = contractSnapshot(migrated);
      expect(migratedContract.settings).toEqual(freshContract.settings);
      expect(migratedContract.claims).toEqual(freshContract.claims);
      expect(
        migrated.prepare("SELECT value FROM settings WHERE key = 'ordinary_fixture'").get(),
      ).toEqual({ value: "byte-for-byte" });
      expect(migrated.prepare("SELECT value FROM settings WHERE key = 'push_hide_details'").get()).toEqual({
        value: "1",
      });
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("creates the exact settings/claims columns, one claims PK autoindex and one exact FK", () => {
    const database = canonicalV20("v20-inventory");
    try {
      expect(() => validateV20Contract(database)).not.toThrow();
      const indexes = database.prepare("PRAGMA index_list(deadline_reminder_claims)").all() as {
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }[];
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatchObject({ unique: 1, origin: "pk", partial: 0 });
      expect(
        (database.prepare(`PRAGMA index_xinfo(${JSON.stringify(indexes[0].name)})`).all() as { name: string | null; coll: string; key: number }[])
          .map(({ name, coll, key }) => [name, coll, key]),
      ).toEqual([
        ["device_id", "BINARY", 1],
        ["item_type", "BINARY", 1],
        ["item_id", "BINARY", 1],
        ["item_created_at", "BINARY", 1],
        ["deadline", "BINARY", 1],
        [null, "BINARY", 0],
      ]);
      expect(database.prepare("PRAGMA foreign_key_list(deadline_reminder_claims)").all()).toEqual([
        expect.objectContaining({
          table: "push_subscriptions",
          from: "device_id",
          to: "id",
          on_update: "NO ACTION",
          on_delete: "CASCADE",
          match: "NONE",
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    [
      "weakened item type CHECK",
      (database: Database.Database) => {
        database.exec("DROP TABLE deadline_reminder_claims");
        database.exec(DEADLINE_REMINDER_CLAIMS_SQL.replace("('task', 'goal')", "('task', 'goal', 'other')"));
      },
      /claims DDL/,
    ],
    [
      "wrong primary-key order",
      (database: Database.Database) => {
        database.exec("DROP TABLE deadline_reminder_claims");
        database.exec(DEADLINE_REMINDER_CLAIMS_SQL.replace(
          "device_id, item_type, item_id, item_created_at, deadline",
          "item_type, device_id, item_id, item_created_at, deadline",
        ));
      },
      /claims DDL/,
    ],
    [
      "wrong foreign-key action",
      (database: Database.Database) => {
        database.exec("DROP TABLE deadline_reminder_claims");
        database.exec(DEADLINE_REMINDER_CLAIMS_SQL.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"));
      },
      /claims DDL/,
    ],
    [
      "secondary index",
      (database: Database.Database) => {
        database.exec("CREATE INDEX claims_deadline_idx ON deadline_reminder_claims(deadline)");
      },
      /claims index inventory/,
    ],
  ] as const)("rejects %s", (_name, mutate, error) => {
    const database = canonicalV20(`v20-${_name.replaceAll(" ", "-")}`);
    try {
      mutate(database);
      expect(() => validateV20Contract(database)).toThrow(error);
    } finally {
      database.close();
    }
  });

  it("rejects settings DDL/index/FK deviations", () => {
    const database = canonicalV20("v20-settings-deviations");
    try {
      database.exec("CREATE INDEX settings_value_idx ON settings(value)");
      expect(() => validateV20Contract(database)).toThrow(/settings index inventory/);
      database.exec("DROP INDEX settings_value_idx");

      database.exec("ALTER TABLE settings RENAME TO settings_source");
      database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT DEFAULT 'x')");
      database.exec("INSERT INTO settings (key, value) SELECT key, value FROM settings_source");
      database.exec("DROP TABLE settings_source");
      expect(() => validateV20Contract(database)).toThrow(/settings DDL/);
    } finally {
      database.close();
    }
  });

  it("accepts every timing boundary and rejects invalid domains/nullability", () => {
    const database = canonicalV20("v20-setting-domains");
    const set = database.prepare("UPDATE settings SET value = ? WHERE key = ?");
    try {
      for (const lead of ["0", "1", "2", "3", "7", "14", "30"]) {
        set.run(lead, "push_lead_days");
        expect(() => validateV20Contract(database), lead).not.toThrow();
      }
      set.run("4", "push_lead_days");
      expect(() => validateV20Contract(database)).toThrow(/push_lead_days/);
      set.run("1", "push_lead_days");

      for (const time of ["00:00", "00:15", "23:30", "23:45"]) {
        set.run(time, "push_send_time");
        expect(() => validateV20Contract(database), time).not.toThrow();
      }
      for (const time of ["24:00", "9:00", "09:01", "09:60"]) {
        set.run(time, "push_send_time");
        expect(() => validateV20Contract(database), time).toThrow(/push_send_time/);
      }
      set.run("09:00", "push_send_time");

      for (const zone of [null, "UTC", "Europe/Berlin"]) {
        set.run(zone, "push_timezone");
        expect(() => validateV20Contract(database), String(zone)).not.toThrow();
      }
      for (const zone of ["Not/AZone", "Europe/Berlín", "A".repeat(129)]) {
        set.run(zone, "push_timezone");
        expect(() => validateV20Contract(database), zone).toThrow(/push_timezone/);
      }
      set.run(null, "push_timezone");

      set.run("22:00", "push_quiet_start");
      set.run("07:00", "push_quiet_end");
      expect(() => validateV20Contract(database)).not.toThrow();
      set.run("22:00", "push_quiet_end");
      expect(() => validateV20Contract(database)).toThrow(/quiet hours/);
      set.run(null, "push_quiet_start");
      expect(() => validateV20Contract(database)).toThrow(/quiet hours/);
      set.run(null, "push_quiet_end");

      database.prepare("INSERT INTO settings (key, value) VALUES ('ordinary_null', NULL)").run();
      expect(() => validateV20Contract(database)).toThrow(/null setting ordinary_null/);
    } finally {
      database.close();
    }
  });

  it("allows inert legacy tables but rejects custom executable schema on them and every view", () => {
    const database = canonicalV20("v20-persistent-inventory");
    try {
      database.exec("CREATE TABLE legacy_fixture (value TEXT)");
      expect(() => validateV20Contract(database)).not.toThrow();
      database.exec(`CREATE TRIGGER ordinary_custom_trigger AFTER INSERT ON legacy_fixture
        BEGIN UPDATE settings SET value = NEW.value WHERE key = 'push_send_time'; END`);
      expect(() => validateV20Contract(database)).toThrow(/persistent trigger ordinary_custom_trigger/);
      database.exec("DROP TRIGGER ordinary_custom_trigger");
      database.exec("CREATE VIEW harmless_looking_view AS SELECT value FROM legacy_fixture");
      expect(() => validateV20Contract(database)).toThrow(/unapproved persistent view/);
    } finally {
      database.close();
    }
  });
});
