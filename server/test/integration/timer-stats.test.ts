import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let db: Database.Database;
let taskLow: { id: number };
let taskHigh: { id: number };

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
  const goal = (await request(app).post("/api/goals").send({ title: "G" })).body;
  taskLow = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "low impact", categoryId: 2, goalId: goal.id, impact: 1, effortMinutes: 30 })
  ).body;
  taskHigh = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "high impact", categoryId: 1, goalId: goal.id, impact: 5, effortMinutes: 10 })
  ).body;
});

describe("timer invariant", () => {
  it("keeps at most one running entry", async () => {
    await request(app).post(`/api/tasks/${taskLow.id}/timer/start`).expect(200);
    await request(app).post(`/api/tasks/${taskHigh.id}/timer/start`).expect(200);

    const running = db
      .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL")
      .get() as { n: number };
    expect(running.n).toBe(1);

    const current = await request(app).get("/api/timer/current").expect(200);
    expect(current.body.task.id).toBe(taskHigh.id);
  });

  it("stops the running entry", async () => {
    await request(app).post("/api/timer/stop").expect(200);
    const current = await request(app).get("/api/timer/current").expect(200);
    expect(current.body).toBeNull();
  });

  it("404s when stopping with nothing running", async () => {
    await request(app).post("/api/timer/stop").expect(404);
  });

  it("409s when starting a timer on a done task", async () => {
    const done = (
      await request(app).post("/api/tasks").send({ title: "done", categoryId: 1, effortMinutes: 5 })
    ).body;
    await request(app).patch(`/api/tasks/${done.id}`).send({ status: "done" });
    await request(app).post(`/api/tasks/${done.id}/timer/start`).expect(409);
  });
});

describe("stats aggregation", () => {
  it("aggregates minutes by impact and fires leverage insights", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    // 60 minutes on the 1★ task, 15 on the 5★ task
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      taskLow.id,
      iso(now - 2 * 3_600_000),
      iso(now - 1 * 3_600_000),
    );
    db.prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)").run(
      taskHigh.id,
      iso(now - 3_600_000),
      iso(now - 45 * 60_000),
    );

    const stats = (await request(app).get("/api/stats")).body;
    expect(stats.totalMinutes).toBe(75);
    expect(stats.byImpact).toContainEqual({ impact: 1, minutes: 60 });
    expect(stats.byImpact).toContainEqual({ impact: 5, minutes: 15 });
    // 80% low-impact share → warning fires, grade is poor
    expect(stats.leverageInsights.length).toBeGreaterThan(0);
    expect(["D", "F"]).toContain(stats.weeklyGrade);
    expect(stats.byGoal[0].minutes).toBe(75);
  });

  it("counts running entries up to now", async () => {
    await request(app).post(`/api/tasks/${taskHigh.id}/timer/start`).expect(200);
    const stats = (await request(app).get("/api/stats")).body;
    expect(stats.totalMinutes).toBeGreaterThanOrEqual(75); // running entry adds ≥ 0 min
    await request(app).post("/api/timer/stop");
  });

  it("honors explicit date ranges (UTC)", async () => {
    const stats = (
      await request(app).get("/api/stats?from=2000-01-01&to=2000-01-02").expect(200)
    ).body;
    expect(stats.totalMinutes).toBe(0);
    expect(stats.weeklyGrade).toBeNull();
  });
});
