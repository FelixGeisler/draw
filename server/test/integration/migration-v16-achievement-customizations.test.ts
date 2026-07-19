import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshApp, testDb } from "../helpers.js";

// User-customizable achievement display metadata (#177, ADR-44) lands in
// migration v16 on a seeded pre-v16 (v15) database: one NEW table,
// achievement_customizations, keyed by achievement key. This file is the
// regression guard for the properties the design pins:
//   * user_version bumps 15 → 16 and the table has the right shape — key TEXT
//     PRIMARY KEY, NULLABLE title/description, hidden INTEGER NOT NULL DEF 0;
//   * NO backfill — the table is empty on a migrated database (every pre-#177
//     achievement reads at its default until edited);
//   * seeded pre-v16 achievement rows survive verbatim (the customization table
//     is a side table, not a rewrite of `achievements`);
//   * fresh-schema parity — a schema.sql database carries the same table.

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf-8");

// The v15 schema: today's schema.sql minus only the v16
// achievement_customizations table (ADDED by the v16 migration).
const v15Schema = currentSchema.replace(
  /-- User-customizable achievement display metadata[\s\S]*?CREATE TABLE achievement_customizations[\s\S]*?\);\r?\n\r?\n/,
  "",
);

beforeAll(async () => {
  expect(v15Schema).not.toBe(currentSchema);
  expect(v15Schema).not.toContain("achievement_customizations");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v15Schema);
  // A pre-#177 unlock, so we can prove the migration does not touch it.
  legacy
    .prepare("INSERT INTO achievements (key, unlocked_at) VALUES ('first_completion', ?)")
    .run("2026-01-01T00:00:00.000Z");
  legacy.pragma("user_version = 15");
  legacy.close();

  await freshApp(); // importing db.ts runs migrate() on the v15 file
});

describe("migration v15 → v16 adds achievement_customizations (#177, ADR-44)", () => {
  it("bumps user_version to 16", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(16);
  });

  it("creates achievement_customizations with the display-override shape", async () => {
    const db = await testDb();
    const cols = db.prepare("PRAGMA table_info(achievement_customizations)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["description", "hidden", "key", "title"]);

    const key = cols.find((c) => c.name === "key")!;
    expect(key.type).toBe("TEXT");
    expect(key.pk).toBe(1);

    // title/description are NULLABLE — NULL means "use the server default".
    expect(cols.find((c) => c.name === "title")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols.find((c) => c.name === "description")).toMatchObject({ type: "TEXT", notnull: 0 });

    // hidden is NOT NULL DEFAULT 0.
    expect(cols.find((c) => c.name === "hidden")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
  });

  it("hidden defaults to 0 when a row omits it", async () => {
    const db = await testDb();
    db.prepare("INSERT INTO achievement_customizations (key, title) VALUES ('draw_10', ?)").run(
      "My draws",
    );
    const row = db
      .prepare("SELECT title, description, hidden FROM achievement_customizations WHERE key = 'draw_10'")
      .get() as { title: string | null; description: string | null; hidden: number };
    expect(row).toEqual({ title: "My draws", description: null, hidden: 0 });
    db.prepare("DELETE FROM achievement_customizations WHERE key = 'draw_10'").run();
  });

  it("does no backfill — the table is empty on a freshly migrated database", async () => {
    const db = await testDb();
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM achievement_customizations")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("leaves the seeded pre-v16 achievement row untouched", async () => {
    const db = await testDb();
    const row = db
      .prepare("SELECT key, unlocked_at AS unlockedAt FROM achievements WHERE key = 'first_completion'")
      .get() as { key: string; unlockedAt: string };
    expect(row).toEqual({ key: "first_completion", unlockedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("fresh-schema parity: a schema.sql database carries the same table", async () => {
    const migrated = await testDb();
    const fresh = new Database(":memory:");
    fresh.exec(currentSchema);

    const colsOf = (h: Database.Database) =>
      (h.prepare("PRAGMA table_info(achievement_customizations)").all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }[]).sort((a, b) => a.name.localeCompare(b.name));
    expect(colsOf(fresh)).toEqual(colsOf(migrated));
    fresh.close();
  });
});
