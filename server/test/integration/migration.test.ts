import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Migration chain on EXISTING databases (fresh ones get the current
// schema.sql — every other integration file covers that path):
//   v2 → v3 adds deferred_until and blocked            (issue #19)
//   v3 → v4 adds subtask_order_mode                    (issue #23)
//   v4 → v5 adds window_days/window_start/window_end   (issue #33)
//   v5 → v6 creates the card_art cache table           (issue #27)
//   v6 → v7 re-parents pre-guard nested breakdowns     (issue #80)
//   v7 → v8 creates the streak_freezes earn log        (issue #58)
//   v8 → v9 adds completions.was_warmup + seeds warmup_every_hours (issue #57)
// This file builds a version-2 database in its private DATA_DIR before the
// app (and thus db.ts with its migrate() call) is imported for the first
// time, so one boot exercises all steps in sequence.

let app: express.Express;
let legacyTaskId: number;

// Pre-guard nested tree (#80): ids captured at seed time because the tree is
// asserted before the legacy-task tests below ever look anything up.
let goalId: number;
let staleGoalId: number;
let rootId: number;
let middleId: number;
let siblingId: number;
let grandchildId: number;
let greatGrandchildId: number;
let doneGrandchildId: number;

beforeAll(async () => {
  // Reconstruct the v2 schema: today's schema.sql minus the v3/v4/v5 columns
  // and the v6 card_art table.
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const current = fs.readFileSync(schemaPath, "utf-8");
  const v2Schema = current
    .replace(
      // \r?\n: checkouts may be CRLF (git autocrlf) or LF.
      /last_drawn_at TEXT,[\s\S]*?window_end TEXT\r?\n/,
      "last_drawn_at TEXT\n",
    )
    .replace(/-- AI card art cache[\s\S]*?CREATE TABLE card_art[\s\S]*?\);\r?\n/, "")
    .replace(/-- Streak freeze tokens[\s\S]*?CREATE TABLE streak_freezes[\s\S]*?\);\r?\n/, "")
    // v9 (#57): strip the was_warmup column (and its comment block)…
    .replace(/,\r?\n  -- Warm-up draw[\s\S]*?was_warmup INTEGER NOT NULL DEFAULT 0/, "")
    // …and the warmup_every_hours seed row.
    .replace(/,\r?\n  \('warmup_every_hours', '8'\)/, "");
  expect(v2Schema).not.toBe(current); // the strip actually removed the columns
  expect(v2Schema).not.toContain("deferred_until");
  expect(v2Schema).not.toContain("subtask_order_mode");
  expect(v2Schema).not.toContain("window_days");
  expect(v2Schema).not.toContain("card_art");
  expect(v2Schema).not.toContain("streak_freezes");
  expect(v2Schema).not.toContain("was_warmup");
  expect(v2Schema).not.toContain("warmup_every_hours");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v2Schema);
  legacy
    .prepare("INSERT INTO tasks (title, category_id, effort_minutes, created_at) VALUES (?, ?, ?, ?)")
    .run("Legacy task", 1, 10, new Date().toISOString());

  // Pre-guard nested breakdown (#80): a 4-level chain plus a sibling and a
  // done grandchild, inserted the way pre-#35 API calls could have written
  // them — parent_id pointing at a task that is itself a subtask, with the
  // deep rows carrying a stale goal/category from before a root-level
  // cascade edit. Distinct ascending created_at keeps the sequential queue
  // order deterministic; all efforts sit under the max_draw_effort default
  // (30) so pool assertions are about structure, not size.
  const insertGoal = legacy.prepare("INSERT INTO goals (title, created_at) VALUES (?, ?)");
  goalId = Number(insertGoal.run("Current goal", "2025-01-01T00:00:00.000Z").lastInsertRowid);
  staleGoalId = Number(insertGoal.run("Stale goal", "2025-01-01T00:00:00.000Z").lastInsertRowid);
  const insertTask = legacy.prepare(
    `INSERT INTO tasks (title, category_id, goal_id, parent_id, effort_minutes, status, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seed = (
    title: string,
    categoryId: number,
    goal: number | null,
    parentId: number | null,
    effort: number,
    status: "open" | "done",
    createdAt: string,
  ) =>
    Number(
      insertTask.run(
        title,
        categoryId,
        goal,
        parentId,
        effort,
        status,
        status === "done" ? "2025-06-02T00:00:00.000Z" : null,
        createdAt,
      ).lastInsertRowid,
    );
  rootId = seed("Nested root", 1, goalId, null, 60, "open", "2025-06-01T00:00:00.000Z");
  middleId = seed("Nested middle", 1, goalId, rootId, 25, "open", "2025-06-01T00:01:00.000Z");
  siblingId = seed("Nested sibling", 1, goalId, rootId, 20, "open", "2025-06-01T00:02:00.000Z");
  grandchildId = seed("Nested grandchild", 2, staleGoalId, middleId, 15, "open", "2025-06-01T00:03:00.000Z");
  greatGrandchildId = seed("Nested great-grandchild", 3, null, grandchildId, 10, "open", "2025-06-01T00:04:00.000Z");
  doneGrandchildId = seed("Nested done grandchild", 2, staleGoalId, middleId, 5, "done", "2025-06-01T00:05:00.000Z");
  // Sanity: the file really contains depth-3 and depth-4 rows before migrate().
  const depth = legacy.prepare(
    `SELECT COUNT(*) AS n FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE p.parent_id IS NOT NULL`,
  );
  expect(depth.get()).toEqual({ n: 3 }); // grandchild, great-grandchild, done grandchild

  legacy.pragma("user_version = 2");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v2 file
});

describe("migration v6 → v7 re-parents pre-guard nested breakdowns to the root (#80, ADR-24)", () => {
  // The tree must not leak into the legacy-task draw expectations below:
  // completing/blocking is done via the same DB the app uses, and the root
  // goes back to 'parallel' so no hold-back state lingers either.
  afterAll(async () => {
    const db = await testDb();
    db.prepare("UPDATE tasks SET subtask_order_mode = 'parallel' WHERE id = ?").run(rootId);
    const block = db.prepare("UPDATE tasks SET blocked = 1 WHERE id = ?");
    for (const id of [rootId, middleId, siblingId, grandchildId, greatGrandchildId, doneGrandchildId]) {
      block.run(id);
    }
  });

  it("flattens the tree to two levels: every former grandchild hangs off the root", async () => {
    const db = await testDb();
    // Structural invariant, arbitrary depth: no task's parent is a subtask.
    const nested = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE p.parent_id IS NOT NULL`,
      )
      .get();
    expect(nested).toEqual({ n: 0 });

    // The formerly invisible rows are now regular, visible subtasks of the root.
    const list = await request(app).get("/api/tasks").expect(200);
    const root = list.body.find((t: { id: number }) => t.id === rootId);
    expect(root).toBeTruthy();
    const byId = new Map(root.subtasks.map((s: { id: number }) => [s.id, s]));
    for (const id of [middleId, siblingId, grandchildId, greatGrandchildId, doneGrandchildId]) {
      expect((byId.get(id) as { parentId: number } | undefined)?.parentId).toBe(rootId);
    }
  });

  it("restores a consistent rollup: the root's remaining effort equals its displayed open children", async () => {
    const list = await request(app).get("/api/tasks").expect(200);
    const root = list.body.find((t: { id: number }) => t.id === rootId);
    // 25 + 20 + 15 + 10 — the done grandchild does not count, and no stored
    // middle estimate hides a grandchild sum anymore.
    expect(root.remainingEffortMinutes).toBe(70);
    const openChildren = root.subtasks.filter((s: { status: string }) => s.status === "open");
    const displayedSum = openChildren.reduce(
      (sum: number, s: { remainingEffortMinutes: number }) => sum + s.remainingEffortMinutes,
      0,
    );
    expect(displayedSum).toBe(root.remainingEffortMinutes); // list no longer contradicts itself
    const middle = root.subtasks.find((s: { id: number }) => s.id === middleId);
    expect(middle.remainingEffortMinutes).toBe(25); // its own estimate again — no hidden children
  });

  it("applies the same cascade rules as a parent edit: goal always, category only while open", async () => {
    const list = await request(app).get("/api/tasks").expect(200);
    const root = list.body.find((t: { id: number }) => t.id === rootId);
    const byId = new Map<number, { goalId: number | null; categoryId: number }>(
      root.subtasks.map((s: { id: number; goalId: number | null; categoryId: number }) => [s.id, s]),
    );
    // Open re-parented rows adopt the root's goal AND category.
    expect(byId.get(grandchildId)).toMatchObject({ goalId, categoryId: 1 });
    expect(byId.get(greatGrandchildId)).toMatchObject({ goalId, categoryId: 1 });
    // Done rows follow the goal (route cascade has no status filter) but keep
    // the category they were finished under (#44).
    expect(byId.get(doneGrandchildId)).toMatchObject({ goalId, categoryId: 2 });
    // Rows that were never nested are untouched.
    expect(byId.get(middleId)).toMatchObject({ goalId, categoryId: 1 });
    expect(byId.get(siblingId)).toMatchObject({ goalId, categoryId: 1 });
  });

  it("makes the pool sane: every drawable task is visible, containers stay out", async () => {
    const pool = await request(app).get("/api/draw/pool").expect(200);
    const poolIds = pool.body.candidates.map((c: { id: number }) => c.id);
    // Exactly the open leaves: the four open subtasks plus the standalone
    // legacy task. The root is a container, the done grandchild is done.
    const legacyList = await request(app).get("/api/tasks").expect(200);
    const legacy = legacyList.body.find((t: { title: string }) => t.title === "Legacy task");
    expect([...poolIds].sort((a, b) => a - b)).toEqual(
      [legacy.id, middleId, siblingId, grandchildId, greatGrandchildId].sort((a, b) => a - b),
    );
    // No invisible-but-drawable card: everything in the pool is either a
    // listed root or a listed subtask.
    const visible = new Set<number>();
    for (const t of legacyList.body) {
      visible.add(t.id);
      for (const s of t.subtasks) visible.add(s.id);
    }
    for (const id of poolIds) expect(visible.has(id)).toBe(true);
  });

  it("the sequential hold-back queue reads the flattened breakdown front-to-back", async () => {
    await request(app)
      .patch(`/api/tasks/${rootId}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);
    const pool = await request(app).get("/api/draw/pool").expect(200);
    const treeIds = new Set([middleId, siblingId, grandchildId, greatGrandchildId]);
    const exposed = pool.body.candidates
      .map((c: { id: number }) => c.id)
      .filter((id: number) => treeIds.has(id));
    // Only the first open step in creation order — no grandchild leaks past
    // the queue anymore.
    expect(exposed).toEqual([middleId]);
    await request(app)
      .patch(`/api/tasks/${rootId}`)
      .send({ subtaskOrderMode: "parallel" })
      .expect(200);
  });

  it("resolves the phantom 409: the former middle task completes without invisible open subtasks", async () => {
    const done = await request(app)
      .patch(`/api/tasks/${middleId}`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.task.status).toBe("done");
    expect(done.body.xpAwarded).toBeGreaterThan(0);
  });
});

describe("migration v2 → v9 (deferred_until, blocked, subtask_order_mode, window_*, card_art, re-parenting, streak_freezes, was_warmup)", () => {
  it("bumps user_version to 9", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(9);
  });

  it("adds completions.was_warmup with default 0 and seeds warmup_every_hours (#57)", async () => {
    const db = await testDb();
    const columns = db.prepare("PRAGMA table_info(completions)").all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const wasWarmup = columns.find((c) => c.name === "was_warmup");
    expect(wasWarmup).toBeTruthy();
    expect(wasWarmup!.notnull).toBe(1);
    expect(wasWarmup!.dflt_value).toBe("0");

    const seed = db
      .prepare("SELECT value FROM settings WHERE key = 'warmup_every_hours'")
      .get() as { value: string } | undefined;
    expect(seed?.value).toBe("8");
    // The migrated setting is public and editable like a fresh install's.
    const settings = await request(app).get("/api/settings").expect(200);
    expect(settings.body.warmup_every_hours).toBe("8");
  });

  it("the migrated database can deal a warm-up (marker keys work without any seed)", async () => {
    const status = await request(app).get("/api/draw/warmup").expect(200);
    expect(status.body).toEqual({ available: true, nextWarmupAt: null });
  });

  it("creates the streak_freezes earn log with its UNIQUE milestone guard (#58)", async () => {
    const db = await testDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'streak_freezes'")
      .get();
    expect(table).toBeTruthy();

    const insert = db.prepare(
      "INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)",
    );
    insert.run("2026-01-07", new Date().toISOString());
    // Idempotence backstop (#58): one earn row per milestone day, ever.
    expect(() => insert.run("2026-01-07", new Date().toISOString())).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM streak_freezes WHERE milestone_day = ?").run("2026-01-07");
  });

  it("creates the card_art cache table with its cascade wired to tasks (#27)", async () => {
    const db = await testDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_art'")
      .get();
    expect(table).toBeTruthy();

    // Cascade sanity directly on the migrated file: art dies with its task.
    const task = db
      .prepare("INSERT INTO tasks (title, category_id, created_at) VALUES (?, ?, ?)")
      .run("cascade probe", 1, new Date().toISOString());
    db.prepare("INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?)").run(
      task.lastInsertRowid,
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>",
      new Date().toISOString(),
    );
    db.prepare("DELETE FROM tasks WHERE id = ?").run(task.lastInsertRowid);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM card_art WHERE task_id = ?").get(task.lastInsertRowid),
    ).toEqual({ n: 0 });
  });

  it("existing rows get the defaults: not blocked, no snooze, parallel subtasks, no window", async () => {
    const list = await request(app).get("/api/tasks").expect(200);
    const legacy = list.body.find((t: { title: string }) => t.title === "Legacy task");
    expect(legacy).toBeTruthy();
    expect(legacy.blocked).toBe(false);
    expect(legacy.deferredUntil).toBeNull();
    expect(legacy.subtaskOrderMode).toBe("parallel");
    expect(legacy.heldBack).toBe(0);
    expect(legacy.windowDays).toBeNull();
    expect(legacy.windowStart).toBeNull();
    expect(legacy.windowEnd).toBeNull();
    legacyTaskId = legacy.id;
  });

  it("the migrated task is drawable and snoozable", async () => {
    const drawn = await request(app).post("/api/draw").send({}).expect(200);
    expect(drawn.body.task.id).toBe(legacyTaskId);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const patched = await request(app)
      .patch(`/api/tasks/${legacyTaskId}`)
      .send({ deferredUntil: until })
      .expect(200);
    expect(patched.body.task.deferredUntil).toBe(until);

    const empty = await request(app).post("/api/draw").send({}).expect(200);
    expect(empty.body.task).toBeNull();
    expect(empty.body.reason).toBe("no_ready_tasks");
  });

  it("the migrated task can host a sequential breakdown (CHECK constraint intact)", async () => {
    await request(app)
      .patch(`/api/tasks/${legacyTaskId}`)
      .send({ subtaskOrderMode: "sequential" })
      .expect(200);
    await request(app)
      .patch(`/api/tasks/${legacyTaskId}`)
      .send({ subtaskOrderMode: "bogus" })
      .expect(400);

    const list = await request(app).get("/api/tasks").expect(200);
    const legacy = list.body.find((t: { id: number }) => t.id === legacyTaskId);
    expect(legacy.subtaskOrderMode).toBe("sequential");
  });

  it("the migrated task accepts and clears an availability window (#33)", async () => {
    const patched = await request(app)
      .patch(`/api/tasks/${legacyTaskId}`)
      .send({ windowDays: [1, 2, 3], windowStart: "08:00", windowEnd: "12:00" })
      .expect(200);
    expect(patched.body.task.windowDays).toEqual([1, 2, 3]);
    expect(patched.body.task.windowStart).toBe("08:00");

    const cleared = await request(app)
      .patch(`/api/tasks/${legacyTaskId}`)
      .send({ windowDays: null })
      .expect(200);
    expect(cleared.body.task.windowDays).toBeNull();
    expect(cleared.body.task.windowStart).toBeNull();
    expect(cleared.body.task.windowEnd).toBeNull();
  });
});
