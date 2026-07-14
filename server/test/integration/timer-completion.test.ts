import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let db: Database.Database;

async function createTask(body: Record<string, unknown>): Promise<{ id: number }> {
  return (await request(app).post("/api/tasks").send({ categoryId: 1, ...body })).body;
}

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

// Issue #12: completing a task must close its own running timer inside the
// completion transaction; a different task's timer stays untouched (ADR-12).
describe("completion closes the task's own timer", () => {
  it("ends the running entry at completion time and /timer/current returns null", async () => {
    const task = await createTask({ title: "own timer", effortMinutes: 10 });
    await request(app).post(`/api/tasks/${task.id}/timer/start`).expect(200);

    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);

    const current = await request(app).get("/api/timer/current").expect(200);
    expect(current.body).toBeNull();

    // ended_at is exactly the completion timestamp, not just "some time later"
    const entry = db
      .prepare(
        "SELECT ended_at AS endedAt FROM time_entries WHERE task_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(task.id) as { endedAt: string | null };
    const completion = db
      .prepare(
        "SELECT completed_at AS completedAt FROM completions WHERE task_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(task.id) as { completedAt: string };
    expect(entry.endedAt).toBe(completion.completedAt);
  });

  it("leaves a different task's running timer untouched", async () => {
    const finished = await createTask({ title: "quick win", effortMinutes: 5 });
    const other = await createTask({ title: "long session", effortMinutes: 25 });
    await request(app).post(`/api/tasks/${other.id}/timer/start`).expect(200);

    await request(app).patch(`/api/tasks/${finished.id}`).send({ status: "done" }).expect(200);

    const current = await request(app).get("/api/timer/current").expect(200);
    expect(current.body).not.toBeNull();
    expect(current.body.task.id).toBe(other.id);
    expect(current.body.entry.endedAt).toBeNull();

    await request(app).post("/api/timer/stop").expect(200);
  });

  it("closes the timer on the recurring path while the task stays open", async () => {
    const chore = await createTask({ title: "water plants", effortMinutes: 10, recurEveryDays: 7 });
    await request(app).post(`/api/tasks/${chore.id}/timer/start`).expect(200);

    const res = await request(app)
      .patch(`/api/tasks/${chore.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(res.body.recurring).toBe(true);
    expect(res.body.task.status).toBe("open");

    const current = await request(app).get("/api/timer/current").expect(200);
    expect(current.body).toBeNull();
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ? AND ended_at IS NULL")
      .get(chore.id) as { n: number };
    expect(open.n).toBe(0);
  });
});
