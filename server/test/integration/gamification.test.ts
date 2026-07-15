import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

describe("gamification", () => {
  it("starts at level 1 with nothing unlocked", async () => {
    const g = (await request(app).get("/api/gamification")).body;
    expect(g).toMatchObject({ xp: 0, level: 1, streak: 0, dailyGoalMet: false });
    expect(g.achievements.every((a: { unlockedAt: string | null }) => a.unlockedAt === null)).toBe(
      true,
    );
  });

  it("pays the 1.5x bonus for drawn completions and unlocks first_completion", async () => {
    const task = (
      await request(app).post("/api/tasks").send({ title: "t", categoryId: 1, effortMinutes: 20 })
    ).body;
    // The bonus is derived server-side (issue #25), not from a client flag.
    // Backdating last_drawn_at within 6h exercises the heuristic path without
    // drawing — POST /api/draw here would steal first_draw from the test below.
    db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      task.id,
    );
    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" })
    ).body;
    expect(done.xpAwarded).toBe(30); // 20 × (3/3) × 1.5
    expect(done.newAchievements).toContain("first_completion");
  });

  it("unlocks first_draw on drawing", async () => {
    await request(app)
      .post("/api/tasks")
      .send({ title: "drawable", categoryId: 1, effortMinutes: 10 });
    const res = (await request(app).post("/api/draw").send({})).body;
    expect(res.newAchievements).toContain("first_draw");
  });

  it("unlocks monster_slayer when the last of 2+ subtasks completes the parent", async () => {
    const parent = (
      await request(app).post("/api/tasks").send({ title: "Monster", categoryId: 1, effortMinutes: 90 })
    ).body;
    const subs = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({ subtasks: [{ title: "a", effortMinutes: 10 }, { title: "b", effortMinutes: 10 }] })
    ).body;
    for (const s of subs) {
      await request(app).patch(`/api/tasks/${s.id}`).send({ status: "done" });
    }
    const done = (
      await request(app).patch(`/api/tasks/${parent.id}`).send({ status: "done" })
    ).body;
    expect(done.newAchievements).toContain("monster_slayer");
  });

  it("computes streaks from consecutive completion days", async () => {
    // Seed a completion yesterday; today already has completions from tests above.
    const task = (
      await request(app).post("/api/tasks").send({ title: "y", categoryId: 1, effortMinutes: 5 })
    ).body;
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, xp_awarded) VALUES (?, ?, 0, 5)",
    ).run(task.id, yesterday);

    const g = (await request(app).get("/api/gamification")).body;
    expect(g.streak).toBe(2);
    expect(g.dailyGoalMet).toBe(true);
    expect(g.todayCompletions.length).toBeGreaterThanOrEqual(4);
  });

  it("exposes the rarity facts (impact, wasDrawn) and goalId on todayCompletions", async () => {
    // Contract guard for issue #62: the client derives foil/silver rarity at
    // render time from exactly these two fields — nothing is stored. A drawn
    // impact-5 completion must surface impact 5 and a truthy wasDrawn.
    // goalId (#115) rides the same live join: the trophy mini-frame gates its
    // level stars on goal linkage (ADR-4), never on impact alone.
    const goal = (await request(app).post("/api/goals").send({ title: "rarity goal" })).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "foil", categoryId: 1, goalId: goal.id, impact: 5, effortMinutes: 10 })
    ).body;
    // Backdate last_drawn_at within 6h — the was_drawn heuristic path, same
    // as the bonus test above (a real POST /api/draw could land elsewhere).
    db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      task.id,
    );
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" });

    const g = (await request(app).get("/api/gamification")).body;
    const entry = g.todayCompletions.find((c: { taskId: number }) => c.taskId === task.id);
    expect(entry).toMatchObject({ impact: 5, wasDrawn: 1, goalId: goal.id });

    // A goal-less completion surfaces goalId: null — "no goal, no star row".
    const bare = g.todayCompletions.find((c: { goalId: number | null }) => c.goalId === null);
    expect(bare).toBeTruthy();
  });

  it("keeps XP consistent with the completions log", async () => {
    const g = (await request(app).get("/api/gamification")).body;
    const sum = db
      .prepare("SELECT COALESCE(SUM(xp_awarded), 0) AS xp FROM completions")
      .get() as { xp: number };
    expect(g.xp).toBe(sum.xp);
  });
});
