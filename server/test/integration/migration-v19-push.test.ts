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
