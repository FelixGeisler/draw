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

describe("estimation block (estimated vs. tracked)", () => {
  // Fixed past range so the seeds cannot collide with entries/completions
  // created by the earlier describes (which live in "now").
  const RANGE = "from=2024-05-01&to=2024-05-07";

  const seedEntry = (taskId: number, startedAt: string, endedAt: string) =>
    db
      .prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)")
      .run(taskId, startedAt, endedAt);
  const seedCompletion = (taskId: number, completedAt: string) =>
    db
      .prepare("INSERT INTO completions (task_id, completed_at, xp_awarded) VALUES (?, ?, 10)")
      .run(taskId, completedAt);

  let report: { id: number };
  let quickFix: { id: number };

  beforeAll(async () => {
    const create = async (body: Record<string, unknown>) =>
      (await request(app).post("/api/tasks").send(body)).body as { id: number };

    // Qualifies: estimate 30, tracked 35 + 15 = 50 min. The first entry
    // starts BEFORE the range — completed-in-range counts all its work.
    report = await create({ title: "write report", categoryId: 1, effortMinutes: 30 });
    seedEntry(report.id, "2024-04-28T10:00:00.000Z", "2024-04-28T10:35:00.000Z");
    seedEntry(report.id, "2024-05-03T10:00:00.000Z", "2024-05-03T10:15:00.000Z");
    seedCompletion(report.id, "2024-05-03T12:00:00.000Z");

    // Qualifies: estimate 20, tracked 10 min.
    quickFix = await create({ title: "quick fix", categoryId: 2, effortMinutes: 20 });
    seedEntry(quickFix.id, "2024-05-04T09:00:00.000Z", "2024-05-04T09:10:00.000Z");
    seedCompletion(quickFix.id, "2024-05-04T12:00:00.000Z");

    // Excluded: no estimate, despite an hour tracked and completed in range.
    const noEstimate = await create({ title: "no estimate", categoryId: 1 });
    seedEntry(noEstimate.id, "2024-05-02T08:00:00.000Z", "2024-05-02T09:00:00.000Z");
    seedCompletion(noEstimate.id, "2024-05-02T10:00:00.000Z");

    // Excluded: estimated and completed in range but never tracked.
    const neverTracked = await create({ title: "never tracked", categoryId: 1, effortMinutes: 25 });
    seedCompletion(neverTracked.id, "2024-05-04T10:00:00.000Z");

    // Excluded: estimated and tracked, but completed after the range.
    const completedLater = await create({ title: "completed later", categoryId: 1, effortMinutes: 10 });
    seedEntry(completedLater.id, "2024-05-05T08:00:00.000Z", "2024-05-05T08:50:00.000Z");
    seedCompletion(completedLater.id, "2024-06-01T10:00:00.000Z");
  });

  it("compares estimates with all tracked time for one-shot tasks completed in range", async () => {
    const stats = (await request(app).get(`/api/stats?${RANGE}`).expect(200)).body;

    expect(stats.estimation.tasks).toEqual([
      // 50/30 → worst under-estimate sorts first
      { taskId: report.id, title: "write report", estimatedMinutes: 30, trackedMinutes: 50, ratio: 1.67 },
      { taskId: quickFix.id, title: "quick fix", estimatedMinutes: 20, trackedMinutes: 10, ratio: 0.5 },
    ]);
    expect(stats.estimation.summary).toEqual({
      taskCount: 2,
      totalEstimatedMinutes: 50,
      totalTrackedMinutes: 60,
      accuracyRatio: 1.2, // 60/50 — estimate-less and untracked tasks do not skew it
      tendency: "under",
    });
  });

  it("breaks the ratio down per category", async () => {
    const stats = (await request(app).get(`/api/stats?${RANGE}`).expect(200)).body;

    expect(stats.estimation.byCategory).toEqual([
      { categoryId: 1, name: "Work", color: "#4f8cff", estimatedMinutes: 30, trackedMinutes: 50, ratio: 1.67 },
      { categoryId: 2, name: "Study", color: "#a06bff", estimatedMinutes: 20, trackedMinutes: 10, ratio: 0.5 },
    ]);
  });

  it("returns a null ratio (not Infinity/NaN) for a range without qualifying tasks", async () => {
    const stats = (
      await request(app).get("/api/stats?from=2000-01-01&to=2000-01-02").expect(200)
    ).body;
    expect(stats.estimation.tasks).toEqual([]);
    expect(stats.estimation.summary.accuracyRatio).toBeNull();
    expect(stats.estimation.summary.tendency).toBeNull();
  });
});

describe("estimation with recurring tasks (#39)", () => {
  // Own fixed past range — no overlap with the seeds above.
  const RANGE = "from=2024-07-01&to=2024-07-07";

  const seedEntry = (taskId: number, startedAt: string, endedAt: string) =>
    db
      .prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)")
      .run(taskId, startedAt, endedAt);
  const seedCompletion = (taskId: number, completedAt: string) =>
    db
      .prepare("INSERT INTO completions (task_id, completed_at, xp_awarded) VALUES (?, ?, 10)")
      .run(taskId, completedAt);

  let chore: { id: number };

  beforeAll(async () => {
    // Recurring chore, estimated at 20 min per cycle.
    chore = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "water plants", categoryId: 2, effortMinutes: 20, recurEveryDays: 3 })
    ).body as { id: number };

    // Cycle 1: 60 min, completed before the range.
    seedEntry(chore.id, "2024-06-28T08:00:00.000Z", "2024-06-28T09:00:00.000Z");
    seedCompletion(chore.id, "2024-06-28T10:00:00.000Z");

    // Cycle 2: 30 min, completed in range — the cycle the stats should show.
    seedEntry(chore.id, "2024-07-02T08:00:00.000Z", "2024-07-02T08:30:00.000Z");
    seedCompletion(chore.id, "2024-07-02T09:00:00.000Z");

    // Cycle 3 underway: 40 min tracked after the in-range completion, not
    // completed yet — belongs to the next cycle, not this one.
    seedEntry(chore.id, "2024-07-03T08:00:00.000Z", "2024-07-03T08:40:00.000Z");
  });

  it("scores only the cycle completed in range, not lifetime tracked time", async () => {
    const stats = (await request(app).get(`/api/stats?${RANGE}`).expect(200)).body;

    // Lifetime attribution would report (60 + 30 + 40) / 20 = 6.5×.
    expect(stats.estimation.tasks).toEqual([
      { taskId: chore.id, title: "water plants", estimatedMinutes: 20, trackedMinutes: 30, ratio: 1.5 },
    ]);
    expect(stats.estimation.summary).toEqual({
      taskCount: 1,
      totalEstimatedMinutes: 20,
      totalTrackedMinutes: 30,
      accuracyRatio: 1.5,
      tendency: "under",
    });
    expect(stats.estimation.byCategory).toEqual([
      { categoryId: 2, name: "Study", color: "#a06bff", estimatedMinutes: 20, trackedMinutes: 30, ratio: 1.5 },
    ]);
  });

  it("keeps every cycle's minutes in the range-filtered time totals", async () => {
    // Per-cycle attribution narrows the estimation block only — total tracked
    // time still counts the in-range entries of cycles 2 and 3 (30 + 40).
    const stats = (await request(app).get(`/api/stats?${RANGE}`).expect(200)).body;
    expect(stats.totalMinutes).toBe(70);
  });
});
