import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// The draws log (#156, ADR-42): every deal writes one append-only row. A real
// POST /api/draw logs was_warmup 0 (gambled); the warm-up deal logs
// was_warmup 1 (handed out, ADR-30). The draws achievement chain counts the
// non-warmup rows only, so the flag has to be right on the way in.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

function drawRows(): { taskId: number | null; wasWarmup: number }[] {
  return db
    .prepare("SELECT task_id AS taskId, was_warmup AS wasWarmup FROM draws ORDER BY id")
    .all() as { taskId: number | null; wasWarmup: number }[];
}

/** Drop the current-draw pointer so the warm-up's idle-deck guard passes. */
function clearDrawState() {
  db.prepare(
    "DELETE FROM settings WHERE key IN ('current_draw_task_id', 'warmup_current_draw', 'warmup_last_dealt')",
  ).run();
}

describe("draws log writes", () => {
  it("POST /api/draw appends a non-warmup row for the drawn task", async () => {
    const task = (
      await request(app).post("/api/tasks").send({ title: "gamble", categoryId: 1, effortMinutes: 10 })
    ).body;
    const res = await request(app).post("/api/draw").send({}).expect(200);
    expect(res.body.task.id).toBe(task.id);

    expect(drawRows()).toEqual([{ taskId: task.id, wasWarmup: 0 }]);
    clearDrawState();
  });

  it("the warm-up deal appends a was_warmup row", async () => {
    // A fresh task under its own goal keeps the deterministic warm-up pick clear.
    const goal = (await request(app).post("/api/goals").send({ title: "warmup log" })).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "handed out", categoryId: 1, goalId: goal.id, effortMinutes: 5 })
    ).body;

    const res = await request(app).post("/api/draw/warmup").send({ goalId: goal.id }).expect(200);
    expect(res.body.task.id).toBe(task.id);

    const warmupRows = db
      .prepare("SELECT task_id AS taskId, was_warmup AS wasWarmup FROM draws WHERE was_warmup = 1")
      .all() as { taskId: number | null; wasWarmup: number }[];
    expect(warmupRows).toEqual([{ taskId: task.id, wasWarmup: 1 }]);
    clearDrawState();
  });

  it("only non-warmup rows advance the draws chain (first_draw counts a real draw)", async () => {
    // The non-warmup count is the source of truth for the draws chain.
    const nonWarmup = db
      .prepare("SELECT COUNT(*) AS n FROM draws WHERE was_warmup = 0")
      .get() as { n: number };
    expect(nonWarmup.n).toBeGreaterThanOrEqual(1);

    const g = (await request(app).get("/api/gamification")).body;
    const firstDraw = g.achievements.find((a: { key: string }) => a.key === "first_draw");
    expect(firstDraw.unlockedAt).not.toBeNull();
  });
});
