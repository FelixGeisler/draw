import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

async function seed(task: Record<string, unknown>) {
  const res = await request(app).post("/api/tasks").send(task).expect(201);
  return res.body;
}

describe("POST /api/draw", () => {
  it("reports an empty deck", async () => {
    const res = await request(app).post("/api/draw").send({}).expect(200);
    expect(res.body.task).toBeNull();
    expect(res.body.reason).toBe("no_ready_tasks");
  });

  it("distinguishes 'everything too big' from 'nothing open'", async () => {
    const big = await seed({ title: "Huge", categoryId: 1, effortMinutes: 120 });
    const res = await request(app).post("/api/draw").send({ categoryId: 1 }).expect(200);
    expect(res.body.reason).toBe("all_too_big");
    await request(app).delete(`/api/tasks/${big.id}`);
  });

  it("draws a drawable task with pool metadata and stamps last_drawn_at", async () => {
    const task = await seed({ title: "Only card", categoryId: 1, effortMinutes: 10 });
    const res = await request(app).post("/api/draw").send({}).expect(200);
    expect(res.body.task.id).toBe(task.id);
    expect(res.body.poolSize).toBe(1);
    expect(res.body.probability).toBe(1);
    expect(res.body.task.lastDrawnAt).toBeTruthy();
  });

  it("never draws containers, unestimated, or oversized tasks", async () => {
    const parent = await seed({ title: "Container", categoryId: 2, effortMinutes: 20 });
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "sub", effortMinutes: 10 }] });
    await seed({ title: "No estimate", categoryId: 2 });
    await seed({ title: "Too big", categoryId: 2, effortMinutes: 45 });

    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/draw").send({ categoryId: 2 }).expect(200);
      expect(res.body.task.title).toBe("sub");
    }
  });

  it("respects the category filter", async () => {
    await seed({ title: "Household chore", categoryId: 3, effortMinutes: 15 });
    const res = await request(app).post("/api/draw").send({ categoryId: 3 }).expect(200);
    expect(res.body.task.title).toBe("Household chore");
  });

  it("biases the distribution toward high-impact low-effort tasks", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "Exam" }).expect(201)
    ).body;
    await seed({ title: "5-star quick", categoryId: 1, goalId: goal.id, impact: 5, effortMinutes: 10 });
    await seed({ title: "1-star slog", categoryId: 1, goalId: goal.id, impact: 1, effortMinutes: 30 });

    const tally: Record<string, number> = {};
    for (let i = 0; i < 120; i++) {
      const res = await request(app).post("/api/draw").send({ goalId: goal.id }).expect(200);
      tally[res.body.task.title] = (tally[res.body.task.title] ?? 0) + 1;
    }
    // weight ratio is 75:1 before cooldown effects — expect clear dominance
    expect(tally["5-star quick"] ?? 0).toBeGreaterThan((tally["1-star slog"] ?? 0) * 3);
  });
});
