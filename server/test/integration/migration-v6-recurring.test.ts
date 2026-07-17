import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// v6 → v7 re-parenting vs. the recurring × sequential ban (#80 × #66, ADR-24).
//
// migration.test.ts runs the whole chain from a version-2 file — a file that
// STRUCTURALLY cannot express this collision, because subtask_order_mode only
// exists from v4 (its seeded root is always 'parallel'). This file seeds a
// genuine v6 database instead (current schema + user_version = 6): a
// 'sequential' root with an open middle step, a RECURRING grandchild under
// the middle, and a great-grandchild below that — the legacy shape where the
// hoist itself MINTS the ADR-23-banned recurring-under-sequential
// combination. ADR-24's decision, pinned here so a future refactor cannot
// silently flip it: the migration must COMPLETE (running the #66 guard on
// the rows it repairs would fail the boot on exactly the legacy data the
// repair exists for), the recurrence must survive the hoist, the result
// stays operable under ADR-23's pre-ban tolerance, and both user repairs
// work while the transition guards keep the combination from being
// re-created once repaired.
//
// A second seeded tree pins the other deliberate ADR-24 side effect: under a
// GOAL-LESS root the cascade adopts goal_id NULL but leaves the hoisted
// row's impact untouched (route-cascade parity with a parent goal unlink;
// the ADR-4 no-op tolerance keeps the row editable).

let app: express.Express;

let goalId: number;
let staleGoalId: number;
// Tree 1: sequential root → open middle → recurring grandchild → great-grandchild.
let seqRootId: number;
let middleId: number;
let recurringId: number;
let deepId: number;
// Tree 2: goal-less root → middle → impact-5 grandchild with a stale goal.
let bareRootId: number;
let bareMiddleId: number;
let bareGrandchildId: number;

beforeAll(async () => {
  // A v6 file has today's TASK schema — v7 repairs data, it changes no DDL —
  // but not the v8 streak_freezes table (#58), so strip that block before
  // seeding and stamp user_version = 6.
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const schema = fs
    .readFileSync(schemaPath, "utf-8")
    .replace(/-- Streak freeze tokens[\s\S]*?CREATE TABLE streak_freezes[\s\S]*?\);\r?\n/, "")
    // …nor the v9 warm-up column and setting seed (#57).
    .replace(/,\r?\n  -- Warm-up draw[\s\S]*?was_warmup INTEGER NOT NULL DEFAULT 0/, "")
    .replace(/,\r?\n  \('warmup_every_hours', '8'\)/, "")
    // …nor the v11 materials.anthropic_file_id column (#92) — the v6 → v11
    // boot re-adds it, and leaving it in the seed would make that ALTER fail
    // with a duplicate column.
    .replace(/  -- Anthropic Files API id[\s\S]*?anthropic_file_id TEXT,\r?\n/, "");
  // Sanity: unlike migration.test.ts's v2 file, this file CAN express the
  // collision — sequential mode and recurrence both exist at v6.
  expect(schema).toContain("subtask_order_mode");
  expect(schema).toContain("recur_every_days");
  expect(schema).toContain("card_art");
  expect(schema).not.toContain("streak_freezes"); // the strip really ran
  expect(schema).not.toContain("was_warmup");
  expect(schema).not.toContain("warmup_every_hours");
  expect(schema).not.toContain("anthropic_file_id");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(schema);

  const insertGoal = legacy.prepare("INSERT INTO goals (title, created_at) VALUES (?, ?)");
  goalId = Number(insertGoal.run("Current goal", "2025-01-01T00:00:00.000Z").lastInsertRowid);
  staleGoalId = Number(insertGoal.run("Stale goal", "2025-01-01T00:00:00.000Z").lastInsertRowid);

  const insertTask = legacy.prepare(
    `INSERT INTO tasks (title, category_id, goal_id, parent_id, impact, effort_minutes, recur_every_days, status, subtask_order_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seed = (
    title: string,
    goal: number | null,
    parentId: number | null,
    impact: number,
    effort: number,
    recurEveryDays: number | null,
    orderMode: "parallel" | "sequential",
    createdAt: string,
  ) =>
    Number(
      insertTask.run(title, 1, goal, parentId, impact, effort, recurEveryDays, "open", orderMode, createdAt)
        .lastInsertRowid,
    );

  // Tree 1 — distinct ascending created_at keeps the sequential queue order
  // deterministic; efforts sit under the max_draw_effort default (30).
  seqRootId = seed("Sequential root", goalId, null, 3, 60, null, "sequential", "2025-06-01T00:00:00.000Z");
  middleId = seed("Open middle step", goalId, seqRootId, 3, 10, null, "parallel", "2025-06-01T00:01:00.000Z");
  recurringId = seed("Recurring grandchild", goalId, middleId, 3, 5, 7, "parallel", "2025-06-01T00:02:00.000Z");
  deepId = seed("Great-grandchild", goalId, recurringId, 3, 5, null, "parallel", "2025-06-01T00:03:00.000Z");

  // Tree 2 — efforts ABOVE max_draw_effort keep these rows out of the pool,
  // so the pool assertions below stay about tree 1's queue alone.
  bareRootId = seed("Goal-less root", null, null, 3, 45, null, "parallel", "2025-06-01T01:00:00.000Z");
  bareMiddleId = seed("Goal-less middle", null, bareRootId, 3, 45, null, "parallel", "2025-06-01T01:01:00.000Z");
  bareGrandchildId = seed("Rated grandchild", staleGoalId, bareMiddleId, 5, 45, null, "parallel", "2025-06-01T01:02:00.000Z");

  // Sanity: the file really is nested (grandchildren + great-grandchild)
  // and really is version 6 before the boot migrates it.
  const nested = legacy
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE p.parent_id IS NOT NULL`,
    )
    .get();
  expect(nested).toEqual({ n: 3 });
  legacy.pragma("user_version = 6");
  legacy.close();

  app = await freshApp(); // importing db.ts runs the v6 → v7 repair
});

async function listedRoot(rootId: number) {
  const list = await request(app).get("/api/tasks").expect(200);
  const root = list.body.find((t: { id: number }) => t.id === rootId);
  expect(root).toBeTruthy();
  return root;
}

describe("v7 hoist under a sequential root mints the ADR-23 combination — tolerated, repairable (#80, ADR-24)", () => {
  it("the migration completes and the recurrence survives the hoist intact", async () => {
    const db = await testDb();
    const { CURRENT_VERSION } = await import("../../src/db.js");
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_VERSION);
    // The #66 guard did NOT run during hoisting: no failure, tree flattened.
    const nested = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE p.parent_id IS NOT NULL`,
      )
      .get();
    expect(nested).toEqual({ n: 0 });

    const root = await listedRoot(seqRootId);
    expect(root.subtaskOrderMode).toBe("sequential");
    const recurring = root.subtasks.find((s: { id: number }) => s.id === recurringId);
    // The banned combination now exists in stored state: a recurring step
    // directly under a sequential root, recurrence intact.
    expect(recurring).toMatchObject({ parentId: seqRootId, recurEveryDays: 7, status: "open" });
    const deep = root.subtasks.find((s: { id: number }) => s.id === deepId);
    expect(deep).toMatchObject({ parentId: seqRootId });
  });

  it("runtime stays operable: list and pool answer, the queue holds the recurring step back like any other", async () => {
    const pool = await request(app).get("/api/draw/pool").expect(200);
    const poolIds = pool.body.candidates.map((c: { id: number }) => c.id);
    // Only the FIRST open step in creation order is exposed — the recurring
    // step sits behind the middle one, held back but not corrupting anything.
    expect(poolIds).toEqual([middleId]);
    const root = await listedRoot(seqRootId);
    const heldBack = root.subtasks
      .filter((s: { heldBack: number }) => s.heldBack === 1)
      .map((s: { id: number }) => s.id)
      .sort((a: number, b: number) => a - b);
    expect(heldBack).toEqual([recurringId, deepId].sort((a, b) => a - b));
  });

  it("the ADR-23 pre-ban tolerance applies: a no-op resend of the stored recurrence passes", async () => {
    const resent = await request(app)
      .patch(`/api/tasks/${recurringId}`)
      .send({ title: "Recurring grandchild (renamed)", recurEveryDays: 7 })
      .expect(200);
    expect(resent.body.task.recurEveryDays).toBe(7);
  });

  it("repair one works — drop the recurrence — and the guard blocks minting the combination anew", async () => {
    const dropped = await request(app)
      .patch(`/api/tasks/${recurringId}`)
      .send({ recurEveryDays: null })
      .expect(200);
    expect(dropped.body.task.recurEveryDays).toBeNull();
    // Once repaired, the migration-minted state cannot be re-created: adding
    // a recurrence back under the still-sequential root is a transition, not
    // a resend, and the #66 guard rejects it.
    const rejected = await request(app)
      .patch(`/api/tasks/${recurringId}`)
      .send({ recurEveryDays: 7 })
      .expect(400);
    expect(rejected.body.error).toMatch(/ADR-23/);
  });

  it("repair two works — flip the root to parallel — and the guard blocks flipping back", async () => {
    // Restore the exact post-migration state (recurrence stored under the
    // sequential root) directly, as the migrated file held it.
    const db = await testDb();
    db.prepare("UPDATE tasks SET recur_every_days = 7 WHERE id = ?").run(recurringId);

    const flipped = await request(app)
      .patch(`/api/tasks/${seqRootId}`)
      .send({ subtaskOrderMode: "parallel" })
      .expect(200);
    expect(flipped.body.task.subtaskOrderMode).toBe("parallel");
    // The recurring step is a legal child of a parallel parent — but the
    // root cannot go back to sequential while it carries the recurrence.
    const rejected = await request(app)
      .patch(`/api/tasks/${seqRootId}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(400);
    expect(rejected.body.error).toMatch(/ADR-23/);
  });
});

describe("v7 hoist under a goal-less root leaves impact grandfathered (#80, ADR-24 / ADR-4)", () => {
  it("the hoisted row holds goal_id NULL with its stored impact — route-cascade parity", async () => {
    const root = await listedRoot(bareRootId);
    const grandchild = root.subtasks.find((s: { id: number }) => s.id === bareGrandchildId);
    // The stale goal was replaced by the root's (none); impact 5 stays — the
    // ADR-4 gate would never accept this pair on a write, but a parent goal
    // unlink cascades exactly the same stored state.
    expect(grandchild).toMatchObject({ parentId: bareRootId, goalId: null, impact: 5 });
    const middle = root.subtasks.find((s: { id: number }) => s.id === bareMiddleId);
    expect(middle).toMatchObject({ parentId: bareRootId, goalId: null });
  });

  it("the row stays editable: the ADR-4 no-op resend tolerance accepts the grandfathered impact", async () => {
    const renamed = await request(app)
      .patch(`/api/tasks/${bareGrandchildId}`)
      .send({ title: "Rated grandchild (renamed)", impact: 5 })
      .expect(200);
    expect(renamed.body.task.impact).toBe(5);
    // A genuinely new impact on the goal-less row is still rejected.
    await request(app).patch(`/api/tasks/${bareGrandchildId}`).send({ impact: 4 }).expect(400);
  });
});
