import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// GET /api/stats/estimation-bias (#55): per-category ALL-history bias with
// the same qualifying rules and per-cycle attribution (ADR-15, #48) as the
// range-scoped estimation block. The server returns every category that has
// qualifying tasks — minimum-sample thresholding is the client's display
// decision, so a 1-task category must still appear here with its taskCount.

let app: express.Express;
let db: Database.Database;

const seedEntry = (taskId: number, startedAt: string, endedAt: string) =>
  db
    .prepare("INSERT INTO time_entries (task_id, started_at, ended_at) VALUES (?, ?, ?)")
    .run(taskId, startedAt, endedAt);
const seedCompletion = (taskId: number, completedAt: string) =>
  db
    .prepare("INSERT INTO completions (task_id, completed_at, xp_awarded) VALUES (?, ?, 10)")
    .run(taskId, completedAt);
const createTask = async (body: Record<string, unknown>) =>
  (await request(app).post("/api/tasks").send(body)).body as { id: number };

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

describe("GET /api/stats/estimation-bias", () => {
  it("returns an empty array on a fresh database", async () => {
    const res = await request(app).get("/api/stats/estimation-bias").expect(200);
    expect(res.body).toEqual([]);
  });

  it("aggregates per category over ALL history, including a below-threshold category", async () => {
    // Category 1 (Work): three qualifying tasks years apart at a consistent
    // 1.5× bias — a range-scoped query would never see 2019 and 2024 together.
    const workSeeds: [string, string, string, number][] = [
      // [startedAt, endedAt, completedAt, estimate] — tracked = 1.5 × estimate
      ["2019-03-01T10:00:00.000Z", "2019-03-01T10:30:00.000Z", "2019-03-01T12:00:00.000Z", 20],
      ["2022-06-01T10:00:00.000Z", "2022-06-01T11:00:00.000Z", "2022-06-01T12:00:00.000Z", 40],
      ["2024-01-01T10:00:00.000Z", "2024-01-01T11:30:00.000Z", "2024-01-01T12:00:00.000Z", 60],
    ];
    for (const [start, end, done, estimate] of workSeeds) {
      const t = await createTask({ title: `work ${estimate}`, categoryId: 1, effortMinutes: estimate });
      seedEntry(t.id, start, end);
      seedCompletion(t.id, done);
    }

    // Category 2 (Study): ONE qualifying task (below MIN_SAMPLE = 3) at 0.5×.
    const study = await createTask({ title: "study once", categoryId: 2, effortMinutes: 60 });
    seedEntry(study.id, "2023-05-01T10:00:00.000Z", "2023-05-01T10:30:00.000Z");
    seedCompletion(study.id, "2023-05-01T12:00:00.000Z");

    // Non-qualifying rows must not appear or count anywhere:
    const noEstimate = await createTask({ title: "no estimate", categoryId: 1 });
    seedEntry(noEstimate.id, "2023-01-01T10:00:00.000Z", "2023-01-01T11:00:00.000Z");
    seedCompletion(noEstimate.id, "2023-01-01T12:00:00.000Z");
    const neverTracked = await createTask({ title: "never tracked", categoryId: 1, effortMinutes: 25 });
    seedCompletion(neverTracked.id, "2023-02-01T12:00:00.000Z");
    await createTask({ title: "still open", categoryId: 2, effortMinutes: 15 });

    const res = await request(app).get("/api/stats/estimation-bias").expect(200);
    // Sorted like the estimation block: largest tracked total first.
    expect(res.body).toEqual([
      { categoryId: 1, name: "Work", color: "#4f8cff", taskCount: 3, ratio: 1.5 },
      { categoryId: 2, name: "Study", color: "#a06bff", taskCount: 1, ratio: 0.5 },
    ]);
  });

  it("applies per-cycle attribution to recurring tasks (ADR-15, #48)", async () => {
    // Fresh category so the seeds above stay out of the assertion.
    const cat = (
      await request(app).post("/api/categories").send({ name: "Chores", color: "#3fbf7f" })
    ).body as { id: number };

    // Recurring: 20 min/cycle estimated. Cycle 1 tracked 40 min, cycle 2
    // checkbox-only (skipped — neither hides the task nor scales the
    // estimate), cycle 3 tracked 20 min. Lifetime naive math would be
    // 60/20 = 3×; per-cycle is 60 / (2 × 20) = 1.5×.
    const chore = await createTask({
      title: "water plants",
      categoryId: cat.id,
      effortMinutes: 20,
      recurEveryDays: 3,
    });
    seedEntry(chore.id, "2024-03-01T08:00:00.000Z", "2024-03-01T08:40:00.000Z");
    seedCompletion(chore.id, "2024-03-01T09:00:00.000Z");
    seedCompletion(chore.id, "2024-03-04T09:00:00.000Z");
    seedEntry(chore.id, "2024-03-06T08:00:00.000Z", "2024-03-06T08:20:00.000Z");
    seedCompletion(chore.id, "2024-03-06T09:00:00.000Z");
    // Next cycle underway — tracked after the last completion, excluded.
    seedEntry(chore.id, "2024-03-07T08:00:00.000Z", "2024-03-07T09:00:00.000Z");

    const res = await request(app).get("/api/stats/estimation-bias").expect(200);
    const chores = (res.body as { name: string; taskCount: number; ratio: number }[]).find(
      (c) => c.name === "Chores",
    );
    expect(chores).toEqual({
      categoryId: cat.id,
      name: "Chores",
      color: "#3fbf7f",
      taskCount: 1,
      ratio: 1.5,
    });
  });
});

describe("GET /api/stats estimation.byCategory taskCount (#55)", () => {
  it("carries the qualifying-task count per category", async () => {
    // The seeds from the all-history test: only the two 2024-01-01-adjacent
    // rows fall into this narrow range — Work's count is range-scoped here.
    const stats = (
      await request(app).get("/api/stats?from=2024-01-01&to=2024-01-02").expect(200)
    ).body;
    expect(stats.estimation.byCategory).toEqual([
      {
        categoryId: 1,
        name: "Work",
        color: "#4f8cff",
        taskCount: 1,
        estimatedMinutes: 60,
        trackedMinutes: 90,
        ratio: 1.5,
      },
    ]);
  });
});
