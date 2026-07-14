import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

describe("task CRUD and breakdown rule", () => {
  it("creates a task and lists it with camelCase fields", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "Prepare exam", categoryId: 2, effortMinutes: 60 })
      .expect(201);
    expect(created.body).toMatchObject({
      title: "Prepare exam",
      categoryId: 2,
      effortMinutes: 60,
      status: "open",
      impact: 3,
    });

    const list = await request(app).get("/api/tasks").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].subtasks).toEqual([]);
  });

  it("rejects tasks without title or category", async () => {
    await request(app).post("/api/tasks").send({ categoryId: 1 }).expect(400);
    await request(app).post("/api/tasks").send({ title: "x" }).expect(400);
  });

  it("bulk-creates subtasks inheriting category and goal", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Big thing", categoryId: 1, effortMinutes: 90 })
    ).body;

    const subs = await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "Step 1", effortMinutes: 15 }, { title: "Step 2", effortMinutes: 25 }] })
      .expect(201);

    expect(subs.body).toHaveLength(2);
    expect(subs.body[0]).toMatchObject({ categoryId: 1, parentId: parent.id });

    const list = await request(app).get("/api/tasks").expect(200);
    const listedParent = list.body.find((t: { id: number }) => t.id === parent.id);
    expect(listedParent.hasOpenChildren).toBe(1);
    expect(listedParent.subtasks).toHaveLength(2);
  });

  it("blocks completing a parent while subtasks are open (409)", async () => {
    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Blocked parent", categoryId: 1 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "child" }] });

    await request(app).patch(`/api/tasks/${parent.id}`).send({ status: "done" }).expect(409);
  });

  it("completes normally and awards XP", async () => {
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Quick win", categoryId: 1, effortMinutes: 30, goalId: null })
    ).body;

    const done = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "done" })
      .expect(200);
    expect(done.body.task.status).toBe("done");
    expect(done.body.xpAwarded).toBe(30); // 30 min × (3/3)
    expect(done.body.recurring).toBe(false);
  });

  it("keeps recurring tasks open and pushes the due date forward", async () => {
    const chore = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Clean kitchen", categoryId: 3, effortMinutes: 20, recurEveryDays: 7 })
    ).body;

    const done = await request(app)
      .patch(`/api/tasks/${chore.id}`)
      .send({ status: "done" })
      .expect(200);

    expect(done.body.recurring).toBe(true);
    expect(done.body.task.status).toBe("open");
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(done.body.task.dueDate).toBe(expected.toISOString().slice(0, 10));
  });

  it("reopening removes the latest completion so XP cannot be farmed", async () => {
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Farmable?", categoryId: 1, effortMinutes: 10 })
    ).body;

    const xpBefore = (await request(app).get("/api/gamification")).body.xp;
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" });
    const xpAfterDone = (await request(app).get("/api/gamification")).body.xp;
    await request(app).patch(`/api/tasks/${task.id}`).send({ status: "open" });
    const xpAfterReopen = (await request(app).get("/api/gamification")).body.xp;

    expect(xpAfterDone).toBeGreaterThan(xpBefore);
    expect(xpAfterReopen).toBe(xpBefore);
  });

  it("deletes a task with cascade to subtasks", async () => {
    const parent = (
      await request(app).post("/api/tasks").send({ title: "Doomed", categoryId: 1 })
    ).body;
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "doomed child" }] });

    await request(app).delete(`/api/tasks/${parent.id}`).expect(200);
    const list = await request(app).get("/api/tasks?status=all").expect(200);
    expect(list.body.some((t: { title: string }) => t.title.startsWith("Doomed"))).toBe(false);
  });
});
