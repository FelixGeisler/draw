import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

describe("goals", () => {
  it("creates goals and tracks task/material counts", async () => {
    const goal = (
      await request(app)
        .post("/api/goals")
        .send({ title: "Pass exam", outcome: "60% to pass", targetDate: "2026-08-10" })
        .expect(201)
    ).body;
    expect(goal).toMatchObject({ title: "Pass exam", taskCount: 0, materialCount: 0 });

    await request(app)
      .post("/api/tasks")
      .send({ title: "past paper", categoryId: 2, goalId: goal.id, impact: 5, effortMinutes: 30 });

    const listed = (await request(app).get("/api/goals")).body;
    expect(listed[0].taskCount).toBe(1);
  });

  it("goal deletion unlinks tasks instead of deleting them", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "Doomed goal" }).expect(201)
    ).body;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "survivor", categoryId: 1, goalId: goal.id, effortMinutes: 10 })
    ).body;

    await request(app).delete(`/api/goals/${goal.id}`).expect(200);
    const tasks = (await request(app).get("/api/tasks")).body;
    const survivor = tasks.find((t: { id: number }) => t.id === task.id);
    expect(survivor).toBeDefined();
    expect(survivor.goalId).toBeNull();
  });
});

describe("materials", () => {
  it("stores notes and text files, downloads and deletes them", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "With materials" }).expect(201)
    ).body;

    await request(app)
      .post(`/api/goals/${goal.id}/materials`)
      .send({ noteText: "chapters 3-5 matter" })
      .expect(201);

    const file = (
      await request(app)
        .post(`/api/goals/${goal.id}/materials`)
        .attach("file", Buffer.from("lecture content: ANOVA"), {
          filename: "lecture.txt",
          contentType: "text/plain",
        })
        .expect(201)
    ).body;

    const list = (await request(app).get(`/api/goals/${goal.id}/materials`)).body;
    expect(list).toHaveLength(2);

    const download = await request(app).get(`/api/materials/${file.id}/download`).expect(200);
    expect(download.text).toContain("ANOVA");

    await request(app).delete(`/api/materials/${file.id}`).expect(200);
    await request(app).get(`/api/materials/${file.id}/download`).expect(404);
  });

  it("rejects unsupported file types", async () => {
    const goal = (
      await request(app).post("/api/goals").send({ title: "Strict" }).expect(201)
    ).body;
    await request(app)
      .post(`/api/goals/${goal.id}/materials`)
      .attach("file", Buffer.from("MZ..."), { filename: "evil.exe", contentType: "application/octet-stream" })
      .expect(400);
  });
});

describe("AI degraded mode (no API key)", () => {
  it("reports unconfigured status", async () => {
    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status.configured).toBe(false);
    // Don't pin the exact model — a model bump must not break this test.
    expect(status.model).toMatch(/^claude-/);
  });

  it("returns 503 on all AI endpoints", async () => {
    await request(app).post("/api/ai/estimate").send({ taskId: 1 }).expect(503);
    await request(app).post("/api/ai/breakdown").send({ taskId: 1 }).expect(503);
    await request(app).post("/api/ai/plan-goal").send({ goalId: 1 }).expect(503);
  });
});
