import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// GET /api/draw/pool (issue #36): the side-effect-free deck snapshot backing
// the MCP draw://deck resource. Same drawability predicate as POST /api/draw
// (ADR-2), but reading it must never mutate anything.

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

async function seed(task: Record<string, unknown>) {
  const res = await request(app).post("/api/tasks").send(task).expect(201);
  return res.body;
}

describe("GET /api/draw/pool", () => {
  it("lists only drawable candidates with weights and probabilities", async () => {
    await seed({ title: "Quick win", categoryId: 1, effortMinutes: 10 });
    await seed({ title: "Too big", categoryId: 1, effortMinutes: 45 });
    await seed({ title: "No estimate", categoryId: 1 });
    const parent = await seed({ title: "Container", categoryId: 1, effortMinutes: 20 });
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "Container leaf", effortMinutes: 5 }] })
      .expect(201);
    const snoozed = await seed({ title: "Snoozed", categoryId: 1, effortMinutes: 10 });
    await request(app)
      .patch(`/api/tasks/${snoozed.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    const blocked = await seed({ title: "Blocked", categoryId: 1, effortMinutes: 10 });
    await request(app).patch(`/api/tasks/${blocked.id}`).send({ blocked: true }).expect(200);

    const res = await request(app).get("/api/draw/pool").expect(200);
    const titles = res.body.candidates.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual(["Container leaf", "Quick win"]);
    expect(res.body.poolSize).toBe(2);
    expect(res.body.maxDrawEffort).toBe(30);

    let probabilitySum = 0;
    for (const c of res.body.candidates) {
      expect(c.weight).toBeGreaterThan(0);
      expect(c.probability).toBeGreaterThan(0);
      probabilitySum += c.probability;
    }
    expect(probabilitySum).toBeCloseTo(1, 6);
  });

  it("mutates nothing: no last_drawn_at stamp, no achievement, no current draw", async () => {
    await request(app).get("/api/draw/pool").expect(200);
    const db = await testDb();

    const stamped = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE last_drawn_at IS NOT NULL")
      .get() as { n: number };
    expect(stamped.n).toBe(0);

    const achievements = db.prepare("SELECT COUNT(*) AS n FROM achievements").get() as {
      n: number;
    };
    expect(achievements.n).toBe(0);

    const currentDraw = db
      .prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'")
      .get();
    expect(currentDraw).toBeUndefined();
  });

  it("excludes held-back sequential siblings exactly like the draw (#23, ADR-18)", async () => {
    // Pool parity: heldBackSql() is part of the shared candidate query, so a
    // sequential parent with two open subtasks must expose exactly one
    // candidate here — the same card POST /api/draw could pick.
    const goal = (
      await request(app).post("/api/goals").send({ title: "pool-parity" }).expect(201)
    ).body;
    const parent = await seed({ title: "Sequential parent", categoryId: 1, goalId: goal.id });
    const subs = (
      await request(app)
        .post(`/api/tasks/${parent.id}/subtasks`)
        .send({
          subtasks: [
            { title: "Step 1", effortMinutes: 10 },
            { title: "Step 2", effortMinutes: 10 },
          ],
          orderMode: "sequential",
        })
        .expect(201)
    ).body;

    const res = await request(app).get(`/api/draw/pool?goalId=${goal.id}`).expect(200);
    expect(res.body.poolSize).toBe(1);
    expect(res.body.candidates.map((c: { id: number; title: string }) => c.title)).toEqual([
      "Step 1",
    ]);
    expect(res.body.candidates[0].id).toBe(subs[0].id);
    expect(res.body.candidates[0].probability).toBe(1);

    // Completing the exposed step frees the sibling with no extra write.
    await request(app).patch(`/api/tasks/${subs[0].id}`).send({ status: "done" }).expect(200);
    const after = await request(app).get(`/api/draw/pool?goalId=${goal.id}`).expect(200);
    expect(after.body.candidates.map((c: { title: string }) => c.title)).toEqual(["Step 2"]);
  });

  it("applies category and goal filters like the draw", async () => {
    await seed({ title: "Household card", categoryId: 3, effortMinutes: 5 });
    const filtered = await request(app).get("/api/draw/pool?categoryId=3").expect(200);
    expect(filtered.body.candidates.map((c: { title: string }) => c.title)).toEqual([
      "Household card",
    ]);

    const empty = await request(app).get("/api/draw/pool?categoryId=999").expect(200);
    expect(empty.body.poolSize).toBe(0);
    expect(empty.body.candidates).toEqual([]);
  });
});
