import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Migration chain on EXISTING databases via ALTER TABLE (fresh ones get the
// current schema.sql — every other integration file covers that path):
//   v2 → v3 adds deferred_until and blocked            (issue #19)
//   v3 → v4 adds subtask_order_mode                    (issue #23)
//   v4 → v5 adds window_days/window_start/window_end   (issue #33)
// This file builds a version-2 database in its private DATA_DIR before the
// app (and thus db.ts with its migrate() call) is imported for the first
// time, so one boot exercises all steps in sequence.

let app: express.Express;
let legacyTaskId: number;

beforeAll(async () => {
  // Reconstruct the v2 schema: today's schema.sql minus the v3/v4/v5 columns.
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const current = fs.readFileSync(schemaPath, "utf-8");
  const v2Schema = current.replace(
    // \r?\n: checkouts may be CRLF (git autocrlf) or LF.
    /last_drawn_at TEXT,[\s\S]*?window_end TEXT\r?\n/,
    "last_drawn_at TEXT\n",
  );
  expect(v2Schema).not.toBe(current); // the strip actually removed the columns
  expect(v2Schema).not.toContain("deferred_until");
  expect(v2Schema).not.toContain("subtask_order_mode");
  expect(v2Schema).not.toContain("window_days");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v2Schema);
  legacy
    .prepare("INSERT INTO tasks (title, category_id, effort_minutes, created_at) VALUES (?, ?, ?, ?)")
    .run("Legacy task", 1, 10, new Date().toISOString());
  legacy.pragma("user_version = 2");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v2 file
});

describe("migration v2 → v5 (deferred_until, blocked, subtask_order_mode, window_*)", () => {
  it("bumps user_version to 5", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(5);
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
