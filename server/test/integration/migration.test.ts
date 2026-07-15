import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Issue #19: user_version 2 → 3 adds deferred_until and blocked to EXISTING
// databases via ALTER TABLE (fresh ones get them from schema.sql — every
// other integration file covers that path). This file builds a version-2
// database in its private DATA_DIR before the app (and thus db.ts with its
// migrate() call) is imported for the first time.

let app: express.Express;
let legacyTaskId: number;

beforeAll(async () => {
  // Reconstruct the v2 schema: today's schema.sql minus the v3 columns.
  const schemaPath = fileURLToPath(new URL("../../src/schema.sql", import.meta.url));
  const current = fs.readFileSync(schemaPath, "utf-8");
  const v2Schema = current.replace(
    // \r?\n: checkouts may be CRLF (git autocrlf) or LF.
    /last_drawn_at TEXT,[\s\S]*?blocked INTEGER NOT NULL DEFAULT 0\r?\n/,
    "last_drawn_at TEXT\n",
  );
  expect(v2Schema).not.toBe(current); // the strip actually removed the columns
  expect(v2Schema).not.toContain("deferred_until");

  const legacy = new Database(path.join(process.env.DATA_DIR!, "app.db"));
  legacy.exec(v2Schema);
  legacy
    .prepare("INSERT INTO tasks (title, category_id, effort_minutes, created_at) VALUES (?, ?, ?, ?)")
    .run("Legacy task", 1, 10, new Date().toISOString());
  legacy.pragma("user_version = 2");
  legacy.close();

  app = await freshApp(); // importing db.ts runs migrate() on the v2 file
});

describe("migration v2 → v3 (deferred_until, blocked)", () => {
  it("bumps user_version to 3", async () => {
    const db = await testDb();
    expect(db.pragma("user_version", { simple: true })).toBe(3);
  });

  it("existing rows get the defaults: not blocked, no snooze", async () => {
    const list = await request(app).get("/api/tasks").expect(200);
    const legacy = list.body.find((t: { title: string }) => t.title === "Legacy task");
    expect(legacy).toBeTruthy();
    expect(legacy.blocked).toBe(false);
    expect(legacy.deferredUntil).toBeNull();
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
});
