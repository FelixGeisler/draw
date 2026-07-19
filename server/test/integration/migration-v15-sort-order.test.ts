import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Stored sibling positions (#157, ADR-43) land in migration v15 on a seeded
// pre-v15 (v14) database: one REAL column, sort_order, backfilled to id, plus
// an AFTER INSERT trigger that stamps sort_order = id on future inserts. This
// file is the regression guard for the three properties the design pins:
//   * the backfill preserves the pre-#157 (created_at, id) sibling order
//     VERBATIM on an organic fixture — nothing moves on migration day;
//   * user_version bumps 14 → 15 and the column shape is REAL NOT NULL DEF 0;
//   * fresh-schema parity — a database created from schema.sql carries the same
//     column and the same stamping trigger as the migrated one.

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf-8");

// The v14 schema: today's schema.sql minus only the v15 sort_order column and
// its stamp trigger (both ADDED by the v15 migration).
const v14Schema = currentSchema
  .replace(/,\r?\n  -- Stored sibling position[\s\S]*?sort_order REAL NOT NULL DEFAULT 0/, "")
  .replace(/-- Stamp sort_order[\s\S]*?END;\r?\n/, "");

let app: express.Express;
let parentId: number;
/** The seeded subtasks in the pre-#157 (created_at, id) order — the order the
 *  backfill must preserve. Captured from the legacy handle before migrate(). */
let preMigrationChildOrder: number[];

beforeAll(async () => {
  expect(v14Schema).not.toBe(currentSchema);
  expect(v14Schema).not.toContain("sort_order");
  expect(v14Schema).not.toContain("tasks_stamp_sort_order");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v14Schema);

  const insertTask = legacy.prepare(
    "INSERT INTO tasks (title, category_id, effort_minutes, parent_id, created_at) VALUES (?, 1, ?, ?, ?)",
  );
  parentId = Number(
    insertTask.run("v15 parent", null, null, "2026-01-01T00:00:00.000Z").lastInsertRowid,
  );
  // Organic breakdown: created_at ascends with id for the first two steps, then
  // a batch group shares one timestamp so the id tie-break decides — exactly
  // the (created_at, id) shape the pre-#157 order used. id order agrees with
  // (created_at, id) order here (the invariant for organically-created rows),
  // so the sort_order = id backfill preserves it exactly.
  insertTask.run("step one", 5, parentId, "2026-01-02T00:00:00.000Z"); // earliest
  insertTask.run("step two", 5, parentId, "2026-01-03T00:00:00.000Z");
  insertTask.run("batch a", 5, parentId, "2026-01-04T00:00:00.000Z"); // shared ts
  insertTask.run("batch b", 5, parentId, "2026-01-04T00:00:00.000Z"); // tie → by id
  legacy.prepare("UPDATE tasks SET subtask_order_mode = 'sequential' WHERE id = ?").run(parentId);

  // Capture the order the PRE-#157 reads used — this is what must not move.
  preMigrationChildOrder = (
    legacy
      .prepare(
        "SELECT id FROM tasks WHERE parent_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(parentId) as { id: number }[]
  ).map((r) => r.id);

  legacy.pragma("user_version = 14");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v14 file
});

describe("migration v14 → v15 adds tasks.sort_order (#157, ADR-43)", () => {
  it("bumps user_version to 15", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(15);
  });

  it("adds sort_order as REAL NOT NULL DEFAULT 0", async () => {
    const db = await testDb();
    const col = (
      db.prepare("PRAGMA table_info(tasks)").all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === "sort_order");
    expect(col).toBeTruthy();
    expect(col!.type).toBe("REAL");
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("0");
  });

  it("backfills sort_order = id for every existing row", async () => {
    const db = await testDb();
    const mismatched = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE sort_order != id")
      .get() as { n: number };
    expect(mismatched.n).toBe(0);
  });

  it("preserves the pre-#157 (created_at, id) sibling order verbatim — nothing moves", async () => {
    const db = await testDb();
    const postOrder = (
      db
        .prepare("SELECT id FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC, id ASC")
        .all(parentId) as { id: number }[]
    ).map((r) => r.id);
    // The new (sort_order, id) order equals the old (created_at, id) order.
    expect(postOrder).toEqual(preMigrationChildOrder);
  });

  it("exposes the same first sequential step the pre-#157 queue would (heldBack via sort_order)", async () => {
    const list = (await request(app).get("/api/tasks").expect(200)).body;
    const parent = list.find((t: { id: number }) => t.id === parentId);
    const exposed = parent.subtasks.filter((s: { heldBack: number }) => s.heldBack === 0);
    // Only the first step in the backfilled order is exposed; the rest queue.
    expect(exposed.map((s: { id: number }) => s.id)).toEqual([preMigrationChildOrder[0]]);
  });

  it("stamps sort_order = id on a NEW insert via the trigger (matching the backfill scheme)", async () => {
    const db = await testDb();
    const r = db
      .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, 1, ?)")
      .run("post-migration insert", new Date().toISOString());
    const stamped = db
      .prepare("SELECT sort_order AS sortOrder FROM tasks WHERE id = ?")
      .get(r.lastInsertRowid) as { sortOrder: number };
    expect(stamped.sortOrder).toBe(Number(r.lastInsertRowid));
    db.prepare("DELETE FROM tasks WHERE id = ?").run(r.lastInsertRowid);
  });

  it("fresh-schema parity: a schema.sql database carries the same column and trigger", async () => {
    const migrated = await testDb();
    const fresh = new Database(":memory:");
    fresh.exec(currentSchema);

    const colOf = (h: Database.Database) =>
      (h.prepare("PRAGMA table_info(tasks)").all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]).find((c) => c.name === "sort_order");
    expect(colOf(fresh)).toEqual(colOf(migrated));

    // The stamp trigger exists on both, so a fresh insert is stamped too.
    const triggerName = "tasks_stamp_sort_order";
    const hasTrigger = (h: Database.Database) =>
      h.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName);
    expect(hasTrigger(fresh)).toBeTruthy();
    expect(hasTrigger(migrated)).toBeTruthy();

    // schema.sql seeds the default categories, so category_id 1 already exists.
    const r = fresh
      .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, 1, ?)")
      .run("fresh insert", new Date().toISOString());
    const stamped = fresh
      .prepare("SELECT sort_order AS sortOrder FROM tasks WHERE id = ?")
      .get(r.lastInsertRowid) as { sortOrder: number };
    expect(stamped.sortOrder).toBe(Number(r.lastInsertRowid));
    fresh.close();
  });
});
