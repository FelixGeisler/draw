import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Stored sibling positions (#157, ADR-43) land in migration v15 on a seeded
// pre-v15 (v14) database: one REAL column, sort_order, backfilled to a
// GLOBAL (created_at, id) rank, plus an AFTER INSERT trigger that stamps an
// unstamped insert MAX(sort_order)+1 (globally latest → appends in any group).
// This file is the
// regression guard for the properties the design pins:
//   * the backfill preserves the pre-#157 (created_at, id) sibling order
//     VERBATIM — INCLUDING a split-in-place breakdown where a part has a later
//     id but an earlier (adopted) created_at, the case a naive sort_order = id
//     backfill silently reorders (the #157 review blocker);
//   * user_version bumps 14 → 15 and the column shape is REAL NOT NULL DEF 0;
//   * a new sibling appends after its group's max regardless of id — so end-
//     moves can never leave a fresh sibling stranded mid-list;
//   * fresh-schema parity — a database created from schema.sql carries the same
//     column and the same stamping trigger as the migrated one.

const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
const currentSchema = fs.readFileSync(schemaPath, "utf-8");

// The v14 schema: today's schema.sql minus only the v15 sort_order column and
// its stamp trigger (both ADDED by the v15 migration).
const v14Schema = currentSchema
  .replace(/,\r?\n  -- Stored sibling position[\s\S]*?sort_order REAL NOT NULL DEFAULT 0/, "")
  .replace(/-- Stamp sort_order[\s\S]*?END;\r?\n/, "")
  // v16 (#177): strip achievement_customizations too — this pre-v15 fixture is
  // pre-v16 as well, so the chain re-adds it; a duplicate CREATE would abort.
  .replace(
    /-- User-customizable achievement display metadata[\s\S]*?CREATE TABLE achievement_customizations[\s\S]*?\);\r?\n\r?\n/,
    "",
  );

let app: express.Express;
let parentId: number;
/** The seeded OPEN subtasks in the pre-#157 (created_at, id) order — the order
 *  the backfill must preserve. Captured from the legacy handle before migrate(). */
let preMigrationChildOrder: number[];
/** The same siblings by pure id order — DIFFERENT from the above because of the
 *  backdated split part, which is exactly why sort_order = id would be wrong. */
let idOnlyOrder: number[];

beforeAll(async () => {
  expect(v14Schema).not.toBe(currentSchema);
  expect(v14Schema).not.toContain("sort_order");
  expect(v14Schema).not.toContain("tasks_stamp_sort_order");
  expect(v14Schema).not.toContain("achievement_customizations");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v14Schema);

  const insertTask = legacy.prepare(
    "INSERT INTO tasks (title, category_id, effort_minutes, parent_id, status, created_at) VALUES (?, 1, ?, ?, ?, ?)",
  );
  const seed = (title: string, parent: number, status: string, createdAt: string) =>
    Number(insertTask.run(title, 5, parent, status, createdAt).lastInsertRowid);

  parentId = Number(
    insertTask.run("v15 parent", null, null, "open", "2026-01-01T00:00:00.000Z").lastInsertRowid,
  );
  // A breakdown that has been through a split-in-place (ADR-16/#108). Rows are
  // inserted in id order, but "step two" is later ARCHIVED and replaced by two
  // parts that adopt its 01-03 timestamp while getting NEW (higher) ids — so id
  // order and (created_at, id) order DISAGREE. This is the case sort_order = id
  // silently reorders (the parts would jump past step three to the end); the
  // per-parent (created_at, id) rank must keep them in step two's slot.
  const one = seed("step one", parentId, "open", "2026-01-02T00:00:00.000Z"); // id lowest
  seed("step two (split away)", parentId, "archived", "2026-01-03T00:00:00.000Z"); // archived original
  const three = seed("step three", parentId, "open", "2026-01-04T00:00:00.000Z"); // later ts, LOWER id than parts
  const b1 = seed("split part one", parentId, "open", "2026-01-03T00:00:00.000Z"); // adopted ts, HIGHER id
  const b2 = seed("split part two", parentId, "open", "2026-01-03T00:00:00.000Z");
  legacy.prepare("UPDATE tasks SET subtask_order_mode = 'sequential' WHERE id = ?").run(parentId);

  // Pre-#157 visible order over the OPEN siblings: step one, then the 01-03
  // parts (by id), then step three at 01-04 → [one, b1, b2, three].
  preMigrationChildOrder = [one, b1, b2, three];
  // Pure id order puts step three (lower id) before the parts → DIFFERENT.
  idOnlyOrder = [one, three, b1, b2];
  // Sanity: the fixture really is an inversion, so the order test can't pass
  // vacuously the way a sort_order = id backfill would let it.
  const legacyOpenOrder = (
    legacy
      .prepare(
        "SELECT id FROM tasks WHERE parent_id = ? AND status != 'archived' ORDER BY created_at ASC, id ASC",
      )
      .all(parentId) as { id: number }[]
  ).map((r) => r.id);
  expect(legacyOpenOrder).toEqual(preMigrationChildOrder);
  expect(preMigrationChildOrder).not.toEqual(idOnlyOrder);

  legacy.pragma("user_version = 14");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v14 file
});

describe("migration v14 → v15 adds tasks.sort_order (#157, ADR-43)", () => {
  it("bumps user_version to 17 (v15 sort_order, then v16 customizations ride the same chain)", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(17);
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

  it("backfills a positive global rank (never the 0 sentinel)", async () => {
    const db = await testDb();
    const zeros = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE sort_order <= 0")
      .get() as { n: number };
    expect(zeros.n).toBe(0);
  });

  it("preserves the pre-#157 (created_at, id) order verbatim across a backdated split part", async () => {
    const db = await testDb();
    const postOrder = (
      db
        .prepare(
          "SELECT id FROM tasks WHERE parent_id = ? AND status != 'archived' ORDER BY sort_order ASC, id ASC",
        )
        .all(parentId) as { id: number }[]
    ).map((r) => r.id);
    // The new (sort_order, id) order equals the old (created_at, id) order…
    expect(postOrder).toEqual(preMigrationChildOrder);
    // …and is NOT the id order a naive sort_order = id backfill would have given
    // — proving the (created_at, id) rank actually did the work.
    expect(postOrder).not.toEqual(idOnlyOrder);
  });

  it("exposes the same first sequential step the pre-#157 queue would (heldBack via sort_order)", async () => {
    const list = (await request(app).get("/api/tasks").expect(200)).body;
    const parent = list.find((t: { id: number }) => t.id === parentId);
    const exposed = parent.subtasks.filter((s: { heldBack: number }) => s.heldBack === 0);
    // Only the first step in the backfilled order is exposed; the rest queue.
    expect(exposed.map((s: { id: number }) => s.id)).toEqual([preMigrationChildOrder[0]]);
  });

  it("appends a NEW sibling after its group — global MAX+1, not by id (the end-move monotonicity fix)", async () => {
    const db = await testDb();
    // The trigger stamps the GLOBAL max + 1, so a new subtask is the latest
    // position everywhere and lands after every existing sibling regardless of
    // its rowid — the guarantee an id-based stamp lost once end-moves inflated
    // a group's max past a fresh id.
    const globalMax = (db.prepare("SELECT MAX(sort_order) AS m FROM tasks").get() as { m: number })
      .m;
    const r = db
      .prepare(
        "INSERT INTO tasks (title, category_id, parent_id, created_at) VALUES (?, 1, ?, ?)",
      )
      .run("appended step", parentId, new Date().toISOString());
    const stamped = (
      db.prepare("SELECT sort_order AS sortOrder FROM tasks WHERE id = ?").get(r.lastInsertRowid) as {
        sortOrder: number;
      }
    ).sortOrder;
    expect(stamped).toBe(globalMax + 1);
    // It sorts LAST among the open siblings — the whole point.
    const order = (
      db
        .prepare(
          "SELECT id FROM tasks WHERE parent_id = ? AND status != 'archived' ORDER BY sort_order ASC, id ASC",
        )
        .all(parentId) as { id: number }[]
    ).map((x) => x.id);
    expect(order[order.length - 1]).toBe(Number(r.lastInsertRowid));
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
    // No tasks yet, so the first root appends after an empty group → rank 1.
    const r = fresh
      .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, 1, ?)")
      .run("fresh insert", new Date().toISOString());
    const stamped = fresh
      .prepare("SELECT sort_order AS sortOrder FROM tasks WHERE id = ?")
      .get(r.lastInsertRowid) as { sortOrder: number };
    expect(stamped.sortOrder).toBe(1);
    fresh.close();
  });
});
